/**
 * The email-nudge half of the repository contract suite (docs/spec/03-architecture.md §7, alpha
 * A6): the `emailNudges` setting and `users.email_id`, which seats are due a nudge, the claim, and
 * the suppression list, run against every adapter. The database is shared with other tests, so
 * every check looks only at its own rows.
 */
import { describe, expect, it } from "vitest";

import { address } from "./auth-contract.js";
import type { NewGamePlayer, NudgeWindow, Repositories } from "./repositories.js";

const T0 = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;
/** Due at T0 + 1 day: idle since T0, not nudged since T0. */
const WINDOW: NudgeWindow = { idleSince: T0, nudgedBefore: T0 };
/** The suite's games are all of this one installed type and version. */
const INSTALLED = [{ gameType: "contract", gameVersion: 1 }];

interface NudgeTarget {
  readonly repos: Repositories;
  sql(statement: string, ...params: (string | number | null)[]): Promise<Record<string, unknown>[]>;
}

/** A fresh 64-hex `emailId`. */
function freshEmailId(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "").slice(0, 64);
}

export function nudgeRepositoryContract(target: () => NudgeTarget): void {
  const repos = (): Repositories => target().repos;

  /** An onboarded human with nudges on (unless `nudges` is false). */
  async function user(nudges = true): Promise<{ id: string; emailId: string }> {
    const id = crypto.randomUUID();
    const emailId = freshEmailId();
    await repos().users.create({
      id,
      email: address(id),
      displayName: "Nudged",
      onboardedAt: T0,
      createdAt: T0,
      updatedAt: T0,
    });
    if (nudges) await repos().users.setEmailNudges(id, { enabled: true, emailId, updatedAt: T0 });
    return { id, emailId };
  }

  /** An active game whose seat 0 belongs to `userId`; overrides apply to that seat. */
  async function seat(
    userId: string,
    overrides: Partial<NewGamePlayer> = {},
    status: "active" | "finished" = "active",
    gameVersion = 1,
  ): Promise<{ gameId: string; playerId: string }> {
    const gameId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    await repos().games.create(
      {
        id: gameId,
        gameType: "contract",
        gameVersion,
        options: "{}",
        status,
        seats: 2,
        turnTimeoutDays: 3,
        seatOrder: "join",
        aiAssistance: "off",
        state: "{}",
        lastActionAt: T0,
        createdAt: T0,
        updatedAt: T0,
        startedAt: T0,
      },
      [
        {
          id: playerId,
          userId,
          seat: 0,
          state: "playing",
          joinedAt: T0,
          toAct: 1,
          toActSince: T0,
          ...overrides,
        },
        { id: crypto.randomUUID(), seat: 1, state: "playing", joinedAt: T0 },
      ],
    );
    return { gameId, playerId };
  }

  async function dueIds(window: NudgeWindow = WINDOW): Promise<Set<string>> {
    return new Set(
      (await repos().nudges.due(window, 10_000, INSTALLED)).map((row) => row.playerId),
    );
  }

  describe("email nudges (A6)", () => {
    it("setEmailNudges changes only that key and holds email_id exactly while nudges are on", async () => {
      const id = crypto.randomUUID();
      const emailId = freshEmailId();
      await repos().users.create({
        id,
        email: address(id),
        settings: JSON.stringify({ whoCanAddMe: "nobody" }),
        createdAt: T0,
        updatedAt: T0,
      });
      const stored = async () => {
        const row = await repos().users.findById(id);
        return { settings: JSON.parse(row?.settings ?? "null") as unknown, emailId: row?.emailId };
      };
      await repos().users.setEmailNudges(id, { enabled: true, emailId, updatedAt: T0 + 1 });
      expect(await stored()).toEqual({
        settings: { whoCanAddMe: "nobody", emailNudges: true },
        emailId,
      });
      expect((await repos().users.findById(id))?.updatedAt).toBe(T0 + 1);
      // Turning it off clears email_id (A6-S-4).
      await repos().users.setEmailNudges(id, { enabled: false, updatedAt: T0 + 2 });
      expect(await stored()).toEqual({
        settings: { whoCanAddMe: "nobody", emailNudges: false },
        emailId: null,
      });
    });

    it("disableNudgesByEmailId turns nudges off and clears email_id, once", async () => {
      const { id, emailId } = await user();
      await repos().users.disableNudgesByEmailId(emailId, T0 + 4);
      const row = await repos().users.findById(id);
      expect(JSON.parse(row?.settings ?? "")).toEqual({ emailNudges: false });
      expect(row?.emailId).toBeNull();
      expect(row?.updatedAt).toBe(T0 + 4);
      // Repeating it, or an unknown emailId, changes nothing.
      await repos().users.disableNudgesByEmailId(emailId, T0 + 5);
      await repos().users.disableNudgesByEmailId(freshEmailId(), T0 + 5);
      expect((await repos().users.findById(id))?.updatedAt).toBe(T0 + 4);
    });

    it("turning nudges on leaves suppressions alone (A6-S2-1)", async () => {
      for (const reason of ["unsubscribed", "bounced", "complained"] as const) {
        const id = crypto.randomUUID();
        const emailId = freshEmailId();
        await repos().users.create({ id, email: address(id), createdAt: T0, updatedAt: T0 });
        await repos().emailSuppressions.suppress(emailId, reason, T0);
        await repos().users.setEmailNudges(id, { enabled: true, emailId, updatedAt: T0 });
        expect(
          await target().sql("SELECT reason FROM email_suppressions WHERE email_hash = ?", emailId),
        ).toEqual([{ reason }]);
      }
    });

    it("an unsubscribed row doesn't stop nudges; a bounce or complaint does, in due and in claim", async () => {
      const due = new Map<string, string>();
      for (const reason of ["unsubscribed", "bounced", "complained"] as const) {
        const { id, emailId } = await user();
        await repos().emailSuppressions.suppress(emailId, reason, T0);
        due.set(reason, (await seat(id)).playerId);
      }
      const listed = await dueIds();
      expect([...due].map(([reason, playerId]) => [reason, listed.has(playerId)])).toEqual([
        ["unsubscribed", true],
        ["bounced", false],
        ["complained", false],
      ]);
      const claims = [];
      for (const playerId of due.values()) {
        claims.push(await repos().nudges.claim(playerId, T0 + DAY, WINDOW));
      }
      expect(claims).toEqual([true, false, false]);
    });

    it("due lists the least recently nudged first, then the longest waiting (A6-S2-2)", async () => {
      // Nudged a day ago and due again, though waiting longest of all.
      const again = await seat((await user()).id, {
        toActSince: T0 - 5 * DAY,
        lastNudgedAt: T0 - DAY,
      });
      const never = await seat((await user()).id, { toActSince: T0 - DAY });
      const order = (await repos().nudges.due(WINDOW, 10_000, INSTALLED)).map(
        (row) => row.playerId,
      );
      expect(order.indexOf(never.playerId)).toBeLessThan(order.indexOf(again.playerId));
    });

    it("setEmailNudges treats unreadable settings as empty", async () => {
      const id = crypto.randomUUID();
      await repos().users.create({
        id,
        email: address(id),
        settings: "[1",
        createdAt: T0,
        updatedAt: T0,
      });
      await repos().users.setEmailNudges(id, { enabled: false, updatedAt: T0 });
      expect((await repos().users.findById(id))?.settings).toBe('{"emailNudges":false}');
    });

    it("email_id is unique", async () => {
      const { emailId } = await user();
      const other = await user();
      await expect(
        repos().users.setEmailNudges(other.id, { enabled: true, emailId, updatedAt: T0 }),
      ).rejects.toThrow();
    });

    it("due lists a seat idle and un-nudged for the window, with what the email needs", async () => {
      const { id, emailId } = await user();
      const { gameId, playerId } = await seat(id);
      const rows = (await repos().nudges.due(WINDOW, 10_000, INSTALLED)).filter(
        (row) => row.playerId === playerId,
      );
      expect(rows).toEqual([
        {
          playerId,
          gameId,
          gameType: "contract",
          gameVersion: 1,
          seat: 0,
          userId: id,
          email: address(id),
          emailId,
        },
      ]);
      // Idle since just after the cut-off: not yet.
      expect((await dueIds({ ...WINDOW, idleSince: T0 - 1 })).has(playerId)).toBe(false);
    });

    it("due leaves out every seat or user that mustn't be nudged", async () => {
      const excluded: string[] = [];
      const add = async (playerId: Promise<{ playerId: string }>) => {
        excluded.push((await playerId).playerId);
      };
      // Nudges off, or never turned on.
      await add(seat((await user(false)).id));
      const never = crypto.randomUUID();
      await repos().users.create({
        id: never,
        email: address(never),
        onboardedAt: T0,
        createdAt: T0,
        updatedAt: T0,
      });
      await add(seat(never));
      // Not in toAct, not playing, nudged within the window, game not active.
      await add(seat((await user()).id, { toAct: 0, toActSince: null }));
      await add(seat((await user()).id, { state: "out", toAct: 0, toActSince: null }));
      await add(seat((await user()).id, { lastNudgedAt: T0 + 1 }));
      await add(seat((await user()).id, {}, "finished"));
      // Suspended, being deleted, not onboarded, suppressed.
      for (const column of ["suspended_at", "deletion_requested_at"]) {
        const { id } = await user();
        await target().sql(`UPDATE users SET ${column} = ? WHERE id = ?`, T0, id);
        await add(seat(id));
      }
      const pending = await user();
      await target().sql("UPDATE users SET onboarded_at = NULL WHERE id = ?", pending.id);
      await add(seat(pending.id));
      const suppressed = await user();
      await repos().emailSuppressions.suppress(suppressed.emailId, "complained", T0);
      await add(seat(suppressed.id));
      // A string "true" isn't true, even with an email_id.
      const stringly = await user();
      await target().sql(
        `UPDATE users SET settings = '{"emailNudges":"true"}' WHERE id = ?`,
        stringly.id,
      );
      await add(seat(stringly.id));
      const due = await dueIds();
      expect(excluded.filter((id) => due.has(id))).toEqual([]);
      // A nudge older than the window is due again.
      const again = await seat((await user()).id, { lastNudgedAt: T0 - DAY });
      expect((await dueIds()).has(again.playerId)).toBe(true);
    });

    it("due lists one seat per recipient, recipients nudged least recently first (A6-P3-1)", async () => {
      // A rules version of this test's own, so the page holds only its seats.
      const version = 1000 + Math.floor(Math.random() * 1_000_000);
      const installed = [{ gameType: "contract", gameVersion: version }];
      // A recipient nudged recently in another game, with two never-nudged seats waiting longest.
      const capped = await user();
      await seat(
        capped.id,
        { toAct: 0, toActSince: null, lastNudgedAt: T0 + DAY },
        "active",
        version,
      );
      const first = await seat(capped.id, { toActSince: T0 - 3 * DAY }, "active", version);
      await seat(capped.id, { toActSince: T0 - 2 * DAY }, "active", version);
      // Another recipient, never nudged, waiting least long.
      const other = await seat((await user()).id, { toActSince: T0 }, "active", version);
      const page = await repos().nudges.due(WINDOW, 2, installed);
      expect(page.map((row) => row.playerId)).toEqual([other.playerId, first.playerId]);
      expect(await repos().nudges.due(WINDOW, 10, installed)).toHaveLength(2);
    });

    it("due lists the longest waiting first and honours the limit", async () => {
      const earlier = await seat((await user()).id, { toActSince: T0 - 2 * DAY - 1 });
      const later = await seat((await user()).id, { toActSince: T0 - 2 * DAY });
      const window = { idleSince: T0 - 2 * DAY, nudgedBefore: T0 };
      const rows = await repos().nudges.due(window, 10_000, INSTALLED);
      const order = rows.map((row) => row.playerId);
      expect(order.indexOf(earlier.playerId)).toBeLessThan(order.indexOf(later.playerId));
      expect(await repos().nudges.due(window, 1, INSTALLED)).toHaveLength(1);
    });

    it("claim sets last_nudged_at once, and only while the seat is still due", async () => {
      const { playerId } = await seat((await user()).id);
      const claims = await Promise.all(
        Array.from({ length: 10 }, () => repos().nudges.claim(playerId, T0 + DAY, WINDOW)),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(
        await target().sql("SELECT last_nudged_at FROM game_players WHERE id = ?", playerId),
      ).toEqual([{ last_nudged_at: T0 + DAY }]);
      expect((await dueIds()).has(playerId)).toBe(false);
      // Nor is a claim of a game's version: nothing but the seat's throttle changes.
      const [game] = await target().sql(
        "SELECT g.version FROM games g JOIN game_players p ON p.game_id = g.id WHERE p.id = ?",
        playerId,
      );
      expect(game).toEqual({ version: 0 });
    });

    it("due lists only games of an installed type and version, so orphans never fill the queue (A6-P-1)", async () => {
      const userId = (await user()).id;
      const orphaned = await seat(userId, { toActSince: T0 - 3 * DAY }, "active", 99);
      const normal = await seat((await user()).id);
      const due = await dueIds();
      expect(due.has(orphaned.playerId)).toBe(false);
      expect(due.has(normal.playerId)).toBe(true);
      expect(await repos().nudges.due(WINDOW, 10_000, [])).toEqual([]);
    });

    it("claim re-checks the user and the game, not only the seat (A6-S-3)", async () => {
      const claim = (playerId: string) => repos().nudges.claim(playerId, T0 + DAY, WINDOW);
      // Unsubscribed between due() and claim().
      const unsubscribed = await user();
      const a = await seat(unsubscribed.id);
      expect((await dueIds()).has(a.playerId)).toBe(true);
      await repos().users.disableNudgesByEmailId(unsubscribed.emailId, T0 + DAY);
      expect(await claim(a.playerId)).toBe(false);
      // Suppressed, suspended, being deleted, or the game no longer active.
      const suppressed = await user();
      const b = await seat(suppressed.id);
      await repos().emailSuppressions.suppress(suppressed.emailId, "bounced", T0);
      expect(await claim(b.playerId)).toBe(false);
      for (const column of ["suspended_at", "deletion_requested_at"]) {
        const { id } = await user();
        const c = await seat(id);
        await target().sql(`UPDATE users SET ${column} = ? WHERE id = ?`, T0, id);
        expect(await claim(c.playerId), column).toBe(false);
      }
      const ended = await seat((await user()).id);
      await target().sql("UPDATE games SET status = 'finished' WHERE id = ?", ended.gameId);
      expect(await claim(ended.playerId)).toBe(false);
      // A seat that has acted since is not claimed.
      const moved = await seat((await user()).id);
      await target().sql("UPDATE game_players SET to_act = 0 WHERE id = ?", moved.playerId);
      expect(await claim(moved.playerId)).toBe(false);
      expect(
        await target().sql(
          "SELECT count(*) AS n FROM game_players WHERE id IN (?, ?, ?, ?) AND last_nudged_at IS NOT NULL",
          a.playerId,
          b.playerId,
          ended.playerId,
          moved.playerId,
        ),
      ).toEqual([{ n: 0 }]);
    });

    it("suppress lets a bounce or complaint replace an unsubscribe, never the reverse (A6-P3-2)", async () => {
      const row = (emailId: string) =>
        target().sql(
          "SELECT reason, created_at FROM email_suppressions WHERE email_hash = ?",
          emailId,
        );
      for (const stronger of ["bounced", "complained"] as const) {
        const emailId = freshEmailId();
        await repos().emailSuppressions.suppress(emailId, "unsubscribed", T0);
        await repos().emailSuppressions.suppress(emailId, stronger, T0 + 1);
        expect(await row(emailId)).toEqual([{ reason: stronger, created_at: T0 + 1 }]);
        await repos().emailSuppressions.suppress(emailId, "unsubscribed", T0 + 2);
        expect(await row(emailId)).toEqual([{ reason: stronger, created_at: T0 + 1 }]);
      }
      const complained = freshEmailId();
      await repos().emailSuppressions.suppress(complained, "complained", T0);
      await repos().emailSuppressions.suppress(complained, "bounced", T0 + 1);
      expect(await row(complained)).toEqual([{ reason: "complained", created_at: T0 }]);
    });

    it("suppress adds an emailId once and keeps the first reason", async () => {
      const emailId = freshEmailId();
      await repos().emailSuppressions.suppress(emailId, "bounced", T0);
      await repos().emailSuppressions.suppress(emailId, "unsubscribed", T0 + 1);
      expect(
        await target().sql(
          "SELECT reason, created_at FROM email_suppressions WHERE email_hash = ?",
          emailId,
        ),
      ).toEqual([{ reason: "bounced", created_at: T0 }]);
    });
  });
}
