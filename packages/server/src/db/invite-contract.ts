/**
 * The email-invite half of the repository contract suite (docs/spec/06-auth.md §6.3–§6.6, 02 §4
 * Invite claims, alpha A17): the suppressions among typed addresses, an inviter's finished games,
 * the sweep's overdue lobbies, which seats an address may claim, which ones the sweep claims, and
 * the claim with every guard, including its races with the lobby's transitions (03 §5.2). Run
 * against every adapter. The database is shared with other tests, so every check looks only at
 * its own rows; games here are created years after the other suites' (`LATER`), so the queries
 * that look across the whole database see only this suite's lobbies first.
 */
import { describe, expect, it } from "vitest";

import type { NormalisedEmail } from "../accounts/email.js";
import { address } from "./auth-contract.js";
import type { GameWriteSet, NewGamePlayer, Repositories } from "./repositories.js";

const DAY = 24 * 60 * 60 * 1000;
/** Far after every other suite's games, so cross-database queries can be cut off before them. */
const LATER = Date.UTC(2031, 0, 1);

interface InviteTarget {
  readonly repos: Repositories;
  sql(statement: string, ...params: (string | number | null)[]): Promise<Record<string, unknown>[]>;
}

/** A fresh 64-hex `emailId`. */
function freshEmailId(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "").slice(0, 64);
}

let clock = LATER;
/** A creation time after every earlier one in this suite: each lobby is the newest so far. */
function nextTime(): number {
  clock += DAY;
  return clock;
}

export function inviteRepositoryContract(target: () => InviteTarget): void {
  const repos = (): Repositories => target().repos;

  /** A human; onboarded unless `onboarded` is false. */
  async function human(
    overrides: { onboarded?: boolean; suspended?: boolean; deleting?: boolean } = {},
  ): Promise<{ id: string; email: NormalisedEmail }> {
    const id = crypto.randomUUID();
    const email = address(id);
    await repos().users.create({
      id,
      email,
      displayName: overrides.onboarded === false ? null : "Invitee",
      onboardedAt: overrides.onboarded === false ? null : LATER,
      suspendedAt: overrides.suspended === true ? LATER : null,
      deletionRequestedAt: overrides.deleting === true ? LATER : null,
      createdAt: LATER,
      updatedAt: LATER,
    });
    return { id, email };
  }

  /**
   * A lobby created by a new user, with one email-invite seat typed as `email` (overrides apply
   * to that seat) and any further rows.
   */
  async function lobby(
    email: NormalisedEmail,
    options: {
      seat?: Partial<NewGamePlayer>;
      others?: readonly NewGamePlayer[];
      status?: "lobby" | "active" | "cancelled";
      createdAt?: number;
    } = {},
  ): Promise<{ gameId: string; playerId: string; creatorId: string }> {
    const creator = await human();
    const gameId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    const createdAt = options.createdAt ?? nextTime();
    await repos().games.create(
      {
        id: gameId,
        gameType: "contract",
        gameVersion: 1,
        options: "{}",
        status: options.status ?? "lobby",
        createdBy: creator.id,
        seats: 3,
        turnTimeoutDays: 3,
        seatOrder: "join",
        aiAssistance: "off",
        lastActionAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      },
      [
        {
          id: crypto.randomUUID(),
          userId: creator.id,
          state: "joined",
          joinedVia: "creator",
          joinedAt: createdAt,
        },
        {
          id: playerId,
          state: "invited",
          inviteEmail: email,
          lastSeenVersion: -1,
          ...options.seat,
        },
        ...(options.others ?? []),
      ],
    );
    return { gameId, playerId, creatorId: creator.id };
  }

  async function row(playerId: string) {
    const [stored] = await target().sql(
      "SELECT user_id, invite_email, state, delivery, last_seen_version FROM game_players WHERE id = ?",
      playerId,
    );
    return stored;
  }

  async function version(gameId: string): Promise<unknown> {
    return (await target().sql("SELECT version FROM games WHERE id = ?", gameId))[0]?.["version"];
  }

  const claimOf = (
    seat: { gameId: string; playerId: string },
    who: { id: string; email: NormalisedEmail },
    overrides: { expectedVersion?: number; inert?: boolean; email?: NormalisedEmail } = {},
  ) => ({
    playerId: seat.playerId,
    gameId: seat.gameId,
    userId: who.id,
    email: overrides.email ?? who.email,
    expectedVersion: overrides.expectedVersion ?? 0,
    inert: overrides.inert ?? false,
  });

  describe("email invites (A17)", () => {
    it("suppressedAmong finds suppressed addresses whatever the reason, in one query", async () => {
      const ids = [freshEmailId(), freshEmailId(), freshEmailId(), freshEmailId()];
      const reasons = ["unsubscribed", "bounced", "complained"] as const;
      for (const [i, reason] of reasons.entries()) {
        await repos().emailSuppressions.suppress(ids[i] ?? "", reason, LATER);
      }
      expect((await repos().emailSuppressions.suppressedAmong(ids)).sort()).toEqual(
        ids.slice(0, 3).sort(),
      );
      expect(await repos().emailSuppressions.suppressedAmong([ids[3] ?? ""])).toEqual([]);
      expect(await repos().emailSuppressions.suppressedAmong([])).toEqual([]);
    });

    it("hasPastOpponent is true once the user has a past-opponent row, and only their own", async () => {
      const [someone, other] = [await human(), await human()];
      expect(await repos().users.hasPastOpponent(someone.id)).toBe(false);
      // A row naming them as the other side is the other user's, not theirs (06 §6.9 both ways).
      await target().sql(
        "INSERT INTO past_opponents (user_id, other_id, last_finished_at) VALUES (?, ?, ?)",
        other.id,
        someone.id,
        LATER,
      );
      expect(await repos().users.hasPastOpponent(someone.id)).toBe(false);
      expect(await repos().users.hasPastOpponent(other.id)).toBe(true);
    });

    it("markSent records sent_at for the given invites only", async () => {
      const seat = await lobby(address());
      const [creator] = await target().sql(
        "SELECT created_by FROM games WHERE id = ?",
        seat.gameId,
      );
      const ids = [crypto.randomUUID(), crypto.randomUUID()];
      for (const id of ids) {
        await target().sql(
          "INSERT INTO invites (id, game_id, inviter_id, email_hash, sent_at, expires_at) VALUES (?, ?, ?, ?, NULL, ?)",
          id,
          seat.gameId,
          String(creator?.["created_by"]),
          freshEmailId(),
          LATER,
        );
      }
      await repos().invites.markSent([ids[0] ?? ""], LATER + 5);
      await repos().invites.markSent([], LATER + 6);
      const rows = await target().sql(
        "SELECT id, sent_at FROM invites WHERE game_id = ? ORDER BY sent_at IS NULL",
        seat.gameId,
      );
      expect(rows).toEqual([
        { id: ids[0], sent_at: LATER + 5 },
        { id: ids[1], sent_at: null },
      ]);
    });

    it("allOverdueLobbies lists lobbies created by the cut-off, oldest first, whoever is in them", async () => {
      const email = address();
      const base = nextTime();
      const old = await lobby(email, { createdAt: base });
      const older = await lobby(email, { createdAt: base - 1 });
      const ended = await lobby(email, { createdAt: base - 2, status: "cancelled" });
      const newer = await lobby(email, { createdAt: base + 1 });
      const listed = await repos().games.allOverdueLobbies(base, 10_000);
      const mine = listed.filter((id) =>
        [old.gameId, older.gameId, ended.gameId, newer.gameId].includes(id),
      );
      expect(mine).toEqual([older.gameId, old.gameId]);
      expect(await repos().games.allOverdueLobbies(base, 1)).toHaveLength(1);
    });

    it("claimable lists only claimable seats typed as the address, in lobbies not yet due", async () => {
      const email = address();
      const cutoff = nextTime();
      const good = await lobby(email, { createdAt: cutoff + 1 });
      const hidden = await lobby(email, { createdAt: cutoff + 2, seat: { delivery: "hidden" } });
      const exclusions = [
        await lobby(email, { createdAt: cutoff + 3, seat: { delivery: "inert" } }),
        await lobby(email, { createdAt: cutoff + 4, seat: { state: "declined" } }),
        await lobby(email, { createdAt: cutoff + 5, seat: { userId: (await human()).id } }),
        await lobby(email, { createdAt: cutoff + 6, status: "active" }),
        await lobby(email, { createdAt: cutoff + 7, status: "cancelled" }),
        // Due to expire: created at the cut-off itself.
        await lobby(email, { createdAt: cutoff }),
        await lobby(address(), { createdAt: cutoff + 8 }),
      ];
      const seats = await repos().invites.claimable(email, cutoff, 100);
      expect(seats).toEqual([
        { playerId: good.playerId, gameId: good.gameId },
        { playerId: hidden.playerId, gameId: hidden.gameId },
      ]);
      expect(exclusions).toHaveLength(7);
      expect(await repos().invites.claimable(email, cutoff, 1)).toHaveLength(1);
    });

    it("pending pairs seats with onboarded humans who hold no other row in the game", async () => {
      const cutoff = nextTime();
      const ready = await human();
      const wanted = await lobby(ready.email, { createdAt: cutoff + 1 });
      const excluded: string[] = [];
      for (const who of [
        await human({ onboarded: false }),
        await human({ suspended: true }),
        await human({ deleting: true }),
      ]) {
        excluded.push((await lobby(who.email, { createdAt: cutoff + 2 })).gameId);
      }
      // Holds another row already: a picked invitation in the same game.
      const twice = await human();
      excluded.push(
        (
          await lobby(twice.email, {
            createdAt: cutoff + 3,
            others: [{ id: crypto.randomUUID(), userId: twice.id, state: "invited" }],
          })
        ).gameId,
      );
      // An address nobody holds.
      excluded.push((await lobby(address(), { createdAt: cutoff + 4 })).gameId);
      const pending = await repos().invites.pending(cutoff, 10_000);
      const mine = pending.filter((seat) => [wanted.gameId, ...excluded].includes(seat.gameId));
      expect(mine).toEqual([
        { playerId: wanted.playerId, gameId: wanted.gameId, userId: ready.id, email: ready.email },
      ]);
    });

    it("claim sets the user and nothing else, without bumping the version", async () => {
      const who = await human();
      const seat = await lobby(who.email, { seat: { delivery: "hidden" } });
      expect(await repos().invites.claim(claimOf(seat, who))).toBe(true);
      expect(await row(seat.playerId)).toEqual({
        user_id: who.id,
        invite_email: who.email,
        state: "invited",
        delivery: "hidden",
        last_seen_version: -1,
      });
      expect(await version(seat.gameId)).toBe(0);
      // Done once: a second claim changes nothing.
      expect(await repos().invites.claim(claimOf(seat, who))).toBe(false);
    });

    it("claim with a block makes the row inert", async () => {
      const who = await human();
      const seat = await lobby(who.email);
      expect(await repos().invites.claim(claimOf(seat, who, { inert: true }))).toBe(true);
      expect(await row(seat.playerId)).toMatchObject({ user_id: who.id, delivery: "inert" });
    });

    it("claim refuses every case the guard covers", async () => {
      const who = await human();
      const refused = async (seat: { gameId: string; playerId: string }, overrides = {}) => {
        expect(await repos().invites.claim(claimOf(seat, who, overrides))).toBe(false);
        expect((await row(seat.playerId))?.["user_id"]).not.toBe(who.id);
      };
      // A version that moved, another address, an inert or taken or declined row, an ended game.
      await refused(await lobby(who.email), { expectedVersion: 1 });
      await refused(await lobby(address()), {});
      await refused(await lobby(who.email, { seat: { delivery: "inert" } }));
      await refused(await lobby(who.email, { seat: { userId: (await human()).id } }));
      await refused(await lobby(who.email, { seat: { state: "removed" } }));
      await refused(await lobby(who.email, { status: "cancelled" }));
      // The claimant already holds a row in the game.
      await refused(
        await lobby(who.email, {
          others: [{ id: crypto.randomUUID(), userId: who.id, state: "joined" }],
        }),
      );
    });

    it("of two claims racing for one seat exactly one wins", async () => {
      const who = await human();
      const seat = await lobby(who.email);
      const results = await Promise.all([
        repos().invites.claim(claimOf(seat, who)),
        repos().invites.claim(claimOf(seat, who)),
        repos().invites.claim(claimOf(seat, who)),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await row(seat.playerId))?.["user_id"]).toBe(who.id);
    });

    describe("races with the lobby's transitions (03 §5.2)", () => {
      /** The writes of a start, a cancel and a remove of the email seat, from version 0. */
      const transitions = (seat: { playerId: string }): Record<string, GameWriteSet> => ({
        start: {
          game: { status: "active", state: "{}", startedAt: LATER, updatedAt: LATER },
          updatePlayers: [
            { id: seat.playerId, set: { state: "dropped", seat: null, inviteEmail: null } },
          ],
        },
        cancel: {
          game: { status: "cancelled", endReason: "cancelled", endedAt: LATER, updatedAt: LATER },
          updatePlayers: [{ id: seat.playerId, set: { inviteEmail: null } }],
        },
        remove: {
          game: { updatedAt: LATER },
          updatePlayers: [
            { id: seat.playerId, set: { state: "removed", removedAt: LATER, inviteEmail: null } },
          ],
        },
      });

      for (const name of ["start", "cancel", "remove"]) {
        it(`claim-vs-${name}: the transition first makes the claim fail`, async () => {
          const who = await human();
          const seat = await lobby(who.email);
          const writes = transitions(seat)[name];
          if (writes === undefined) throw new Error(name);
          expect(await repos().games.applyTransition(seat.gameId, 0, writes)).toBe("ok");
          expect(await repos().invites.claim(claimOf(seat, who))).toBe(false);
          expect((await row(seat.playerId))?.["user_id"]).toBeNull();
        });

        it(`claim-vs-${name}: the claim first leaves the transition to win as usual`, async () => {
          const who = await human();
          const seat = await lobby(who.email);
          const writes = transitions(seat)[name];
          if (writes === undefined) throw new Error(name);
          expect(await repos().invites.claim(claimOf(seat, who))).toBe(true);
          // Not a transition: the version didn't move, so one computed before still applies.
          expect(await repos().games.applyTransition(seat.gameId, 0, writes)).toBe("ok");
          expect(await row(seat.playerId)).toMatchObject({ user_id: who.id, invite_email: null });
        });

        it(`claim-vs-${name}, together: both settle consistently`, async () => {
          const who = await human();
          const seat = await lobby(who.email);
          const writes = transitions(seat)[name];
          if (writes === undefined) throw new Error(name);
          const [claimed, moved] = await Promise.all([
            repos().invites.claim(claimOf(seat, who)),
            repos().games.applyTransition(seat.gameId, 0, writes),
          ]);
          expect(moved).toBe("ok");
          const stored = await row(seat.playerId);
          expect(stored?.["user_id"]).toBe(claimed ? who.id : null);
          expect(stored?.["invite_email"]).toBeNull();
        });
      }
    });
  });
}
