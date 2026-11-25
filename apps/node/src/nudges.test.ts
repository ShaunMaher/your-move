/**
 * The "It's your turn" email nudges and the unsubscribe route (docs/spec/03-architecture.md §7,
 * §8; 05 §Email links; 08 T6, T14, T17, T18; alpha A6), end to end on the real app and a real
 * SQLite database: the setting, the sweep's rules, the email, and the one-click unsubscribe.
 */
import {
  type CapturedEmail,
  deriveSubkeys,
  emailId as emailIdOf,
  type EmailSender,
  normaliseAddress,
} from "@your-move/server";
import { unsubscribeToken } from "@your-move/server/testing";
import { afterEach, describe, expect, it } from "vitest";

import {
  act,
  call,
  createGame,
  type ExampleView,
  gameHarness,
  getGame,
  type Player,
  signUp,
  transition,
} from "./games-support.js";
import { codeOf, DAY, type Harness, HOUR, MINUTE, T0 } from "./test-harness.js";

function fail(): never {
  throw new Error("unreachable");
}

let h: Harness;
afterEach(() => {
  h.close();
});

const SUBJECT = "It's your turn in Example on Family Games";
const UNSUBSCRIBE = "/api/v1/email/unsubscribe";

interface Me {
  readonly settings: { readonly emailNudges: boolean; readonly whoCanAddMe: string };
}

async function setNudges(player: Player, on: boolean): Promise<Me> {
  const result = await call<Me>(h, player, "PATCH", "/api/v1/me", {
    settings: { emailNudges: on },
  });
  expect(result.status).toBe(200);
  return result.body;
}

async function nudgesOf(player: Player): Promise<boolean> {
  return (await call<Me>(h, player, "GET", "/api/v1/me")).body.settings.emailNudges;
}

/** Two players in an active example game, both in `toAct` from the start (T0). */
async function started(options: { ada?: boolean; bo?: boolean } = {}) {
  const ada = await signUp(h, "Ada");
  const bo = await signUp(h, "Bo");
  if (options.ada === true) await setNudges(ada, true);
  if (options.bo === true) await setNudges(bo, true);
  const created = await createGame(h, ada, {
    gameType: "example",
    invitees: [{ email: bo.email }],
  });
  const accepted = await transition(h, bo, created.id, "accept");
  expect(accepted.body.game.status).toBe("active");
  return { ada, bo, gameId: created.id };
}

/** Plays `player`'s first card. */
async function play(player: Player, gameId: string): Promise<void> {
  const { view } = await getGame(h, player, gameId);
  const seat = (view as ExampleView).you ?? 0;
  const card = (view as ExampleView).seats[seat]?.hand?.[0];
  const moved = await act(h, player, gameId, { card });
  expect(moved.status).toBe(200);
}

async function nudgesTo(player: Player): Promise<CapturedEmail[]> {
  return (await h.emails()).filter(
    (email) => email.to === player.email && email.subject === SUBJECT,
  );
}

function tokenOf(email: CapturedEmail | undefined): string {
  const url = new URL(email?.listUnsubscribe ?? "");
  return url.searchParams.get("t") ?? "";
}

function form(token: string, origin: string | null = "https://elsewhere.example") {
  return h.request("POST", `${UNSUBSCRIBE}?t=${encodeURIComponent(token)}`, undefined, {
    origin,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    rawBody: "List-Unsubscribe=One-Click",
  });
}

describe("the emailNudges setting (PATCH /api/v1/me)", () => {
  it("is off by default and changes only when asked", async () => {
    h = gameHarness();
    const ada = await signUp(h, "Ada");
    expect(await nudgesOf(ada)).toBe(false);
    expect((await setNudges(ada, true)).settings).toEqual({
      emailNudges: true,
      whoCanAddMe: "pastOpponents",
    });
    expect(await nudgesOf(ada)).toBe(true);
    // A display-name change leaves the setting alone.
    const renamed = await call<Me>(h, ada, "PATCH", "/api/v1/me", { displayName: "Ada L" });
    expect(renamed.body.settings.emailNudges).toBe(true);
    expect((await setNudges(ada, false)).settings.emailNudges).toBe(false);
    // Off clears the stored emailId (A6-S-4).
    expect(h.query("SELECT email_id FROM users WHERE id = ?", ada.id)).toEqual([
      { email_id: null },
    ]);
  });

  it("reads each stored setting on its own: one unreadable value doesn't reset the others (A6-P-12)", async () => {
    h = gameHarness();
    const ada = await signUp(h, "Ada");
    h.exec(
      "UPDATE users SET settings = ? WHERE id = ?",
      JSON.stringify({ whoCanAddMe: "nobody", emailNudges: "yes" }),
      ada.id,
    );
    expect((await call<Me>(h, ada, "GET", "/api/v1/me")).body.settings).toEqual({
      whoCanAddMe: "nobody",
      emailNudges: false,
    });
    h.exec("UPDATE users SET settings = '[1,2]' WHERE id = ?", ada.id);
    expect((await call<Me>(h, ada, "GET", "/api/v1/me")).body.settings).toEqual({
      whoCanAddMe: "pastOpponents",
      emailNudges: false,
    });
  });

  it("refuses to turn nudges on for an account without an address (A6-P-8)", async () => {
    h = gameHarness();
    const ada = await signUp(h, "Ada");
    h.exec("UPDATE users SET email = NULL WHERE id = ?", ada.id);
    expect(
      (await call(h, ada, "PATCH", "/api/v1/me", { settings: { emailNudges: true } })).status,
    ).toBe(400);
    expect(h.query("SELECT settings, email_id FROM users WHERE id = ?", ada.id)).toEqual([
      { settings: "{}", email_id: null },
    ]);
  });

  it("turning nudges on keeps an unsubscribed row, which doesn't stop nudges; a bounce does (A6-S2-1)", async () => {
    h = gameHarness();
    const { ada, bo } = await started({});
    const keys = await deriveSubkeys(h.platform.config.appSecret);
    const idOf = async (player: Player) =>
      emailIdOf(keys, normaliseAddress(player.email) ?? fail());
    h.exec(
      "INSERT INTO email_suppressions (email_hash, reason, created_at) VALUES (?, 'unsubscribed', ?), (?, 'bounced', ?)",
      await idOf(ada),
      T0,
      await idOf(bo),
      T0,
    );
    await setNudges(ada, true);
    await setNudges(bo, true);
    expect(h.query("SELECT reason FROM email_suppressions ORDER BY reason")).toEqual([
      { reason: "bounced" },
      { reason: "unsubscribed" },
    ]);
    h.setTime(T0 + DAY);
    expect((await h.sweep()).nudges).toMatchObject({ due: 1, sent: 1 });
    expect(await nudgesTo(ada)).toHaveLength(1);
    expect(await nudgesTo(bo)).toHaveLength(0);
  });

  it("keeps the other stored settings and records the address's emailId", async () => {
    h = gameHarness();
    const ada = await signUp(h, "Ada");
    h.exec(
      "UPDATE users SET settings = ? WHERE id = ?",
      JSON.stringify({ whoCanAddMe: "nobody", lastGameType: "example" }),
      ada.id,
    );
    await setNudges(ada, true);
    const [row] = h.query("SELECT settings, email_id FROM users WHERE id = ?", ada.id);
    expect(JSON.parse(String(row?.["settings"]))).toEqual({
      whoCanAddMe: "nobody",
      lastGameType: "example",
      emailNudges: true,
    });
    expect(row?.["email_id"]).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses unknown settings and non-boolean values", async () => {
    h = gameHarness();
    const ada = await signUp(h, "Ada");
    for (const settings of [
      { emailNudges: "yes" },
      { theme: "dark" },
      { emailNudges: true, x: 1 },
    ]) {
      const result = await call(h, ada, "PATCH", "/api/v1/me", { settings });
      expect(result.status).toBe(400);
    }
    expect(await nudgesOf(ada)).toBe(false);
  });
});

describe("the sweep's email nudges (03 §7)", () => {
  it("sends nothing to anyone with nudges off (the default)", async () => {
    h = gameHarness();
    await started();
    h.advance(3 * DAY);
    expect((await h.sweep()).nudges).toEqual({
      due: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      capped: false,
    });
    expect((await h.emails()).filter((email) => email.subject === SUBJECT)).toEqual([]);
  });

  it("nudges after 24 h in toAct, not before, and only the seat whose turn it is", async () => {
    h = gameHarness();
    const { ada, bo, gameId } = await started({ ada: true, bo: true });
    await play(ada, gameId);
    h.setTime(T0 + DAY - MINUTE);
    expect((await h.sweep()).nudges?.sent).toBe(0);
    h.setTime(T0 + DAY);
    expect((await h.sweep()).nudges?.sent).toBe(1);
    expect(await nudgesTo(bo)).toHaveLength(1);
    expect(await nudgesTo(ada)).toHaveLength(0);
  });

  it("nudges at most once per game per day, even across sweeps", async () => {
    h = gameHarness();
    const { bo } = await started({ bo: true });
    h.setTime(T0 + DAY);
    await h.sweep();
    await h.sweep();
    h.advance(DAY - MINUTE);
    await h.sweep();
    expect(await nudgesTo(bo)).toHaveLength(1);
    h.advance(MINUTE);
    await h.sweep();
    expect(await nudgesTo(bo)).toHaveLength(2);
  });

  it("nudges for each game separately, one game per recipient per run", async () => {
    h = gameHarness();
    const { ada, bo } = await started({ bo: true });
    const second = await createGame(h, ada, {
      gameType: "example",
      invitees: [{ email: bo.email }],
    });
    await transition(h, bo, second.id, "accept");
    h.setTime(T0 + DAY);
    expect((await h.sweep()).nudges).toMatchObject({ due: 1, sent: 1 });
    h.advance(15 * MINUTE);
    expect((await h.sweep()).nudges).toMatchObject({ due: 1, sent: 1 });
    expect(await nudgesTo(bo)).toHaveLength(2);
    h.advance(15 * MINUTE);
    expect((await h.sweep()).nudges).toMatchObject({ due: 0 });
  });

  it("restarts the idle clock when the seat acts and is to act again", async () => {
    h = gameHarness();
    const { ada, bo, gameId } = await started({ ada: true });
    h.setTime(T0 + 12 * HOUR);
    await play(ada, gameId);
    await play(bo, gameId);
    // The round resolved at T0 + 12 h; Ada is to act again from then.
    expect((await getGame(h, ada, gameId)).game.status).toBe("active");
    h.setTime(T0 + DAY);
    expect((await h.sweep()).nudges?.sent).toBe(0);
    h.setTime(T0 + 36 * HOUR);
    expect((await h.sweep()).nudges?.sent).toBe(1);
  });

  it("sends nothing for a game that isn't active", async () => {
    h = gameHarness();
    const { ada, gameId } = await started({ ada: true, bo: true });
    expect((await transition(h, ada, gameId, "resign")).status).toBe(200);
    h.setTime(T0 + 2 * DAY);
    expect((await h.sweep()).nudges).toMatchObject({ due: 0 });
  });

  it("never lets orphaned games fill the queue: 100 orphaned seats and one normal one (A6-P-1)", async () => {
    h = gameHarness();
    const { bo, gameId } = await started({ bo: true });
    const repos = h.platform.repos;
    for (let i = 0; i < 100; i++) {
      const id = crypto.randomUUID();
      await repos.games.create(
        {
          id,
          gameType: "example",
          gameVersion: 99,
          options: "{}",
          status: "active",
          seats: 2,
          turnTimeoutDays: 3,
          seatOrder: "join",
          aiAssistance: "off",
          state: "{}",
          lastActionAt: T0 - DAY,
          createdAt: T0 - DAY,
          updatedAt: T0 - DAY,
          startedAt: T0 - DAY,
        },
        [
          {
            id: crypto.randomUUID(),
            userId: bo.id,
            seat: 0,
            state: "playing",
            joinedAt: T0 - DAY,
            toAct: 1,
            // Waiting longer than the real game: first in the queue if orphans were in it.
            toActSince: T0 - DAY,
          },
        ],
      );
    }
    h.setTime(T0 + DAY);
    expect((await h.sweep()).nudges).toMatchObject({ due: 1, sent: 1, skipped: 0, capped: false });
    const [email] = await nudgesTo(bo);
    expect(email?.text).toContain(`/g/${gameId}`);
    expect(
      h.query("SELECT count(*) AS n FROM game_players WHERE last_nudged_at IS NOT NULL"),
    ).toEqual([{ n: 1 }]);
  });

  const alerts = () =>
    h.logs.filter((line) => line["alert"] === "NUDGE_EMAILS_PER_DAY" && line["level"] === "error");
  const counted = (key: string) =>
    h.query("SELECT coalesce(sum(count), 0) AS n FROM rate_limits WHERE key = ?", key)[0]?.["n"];

  it("stops at the instance-wide daily cap without claiming or counting the rest, and alerts once (A6-S-1, P2-2)", async () => {
    h = gameHarness({ LIMIT_NUDGE_EMAILS_PER_DAY: "1" });
    const { ada, bo } = await started({ ada: true, bo: true });
    h.setTime(T0 + DAY);
    // Capped: how many were due isn't reported (A6-P2-7).
    expect((await h.sweep()).nudges).toEqual({ sent: 1, failed: 0, skipped: 0, capped: true });
    expect(alerts()).toHaveLength(1);
    expect(
      h.query("SELECT count(*) AS n FROM game_players WHERE last_nudged_at IS NOT NULL"),
    ).toEqual([{ n: 1 }]);
    // Only the claimed nudge was counted.
    expect(counted("NUDGE_EMAILS_PER_DAY:all")).toBe(1);
    // The next run reads the cap and does nothing more, with no second alert.
    h.advance(15 * MINUTE);
    expect((await h.sweep()).nudges).toEqual({ sent: 0, failed: 0, skipped: 0, capped: true });
    expect(alerts()).toHaveLength(1);
    expect(counted("NUDGE_EMAILS_PER_DAY:all")).toBe(1);
    expect([...(await nudgesTo(ada)), ...(await nudgesTo(bo))]).toHaveLength(1);
    // Two days on, the window has passed and the other seat gets its nudge.
    h.advance(2 * DAY);
    await h.sweep();
    expect([...(await nudgesTo(ada)), ...(await nudgesTo(bo))].length).toBeGreaterThan(1);
  });

  it("under saturation across a window boundary, sends about the cap a day and alerts once per window (A6-P2-2)", async () => {
    h = gameHarness({ LIMIT_NUDGE_EMAILS_PER_DAY: "3" });
    // Three games, six seats, everyone opted in: twice as many due as the cap allows.
    for (let i = 0; i < 3; i++) await started({ ada: true, bo: true });
    const start = T0 + DAY;
    let sent = 0;
    for (let at = start; at < start + DAY; at += 15 * MINUTE) {
      h.setTime(at);
      sent += (await h.sweep()).nudges?.sent ?? 0;
    }
    // A sliding window: the cap, plus at most one as the previous day's weight fades.
    expect(sent).toBeGreaterThanOrEqual(3);
    expect(sent).toBeLessThanOrEqual(3 + 1);
    expect(counted("NUDGE_EMAILS_PER_DAY:all")).toBe(sent);
    // The 24 hours span two fixed windows (midnight UTC): one alert in each, never more.
    const days = alerts().map((line) => String(line["time"]).slice(0, 10));
    expect(days).toEqual(["2026-01-02", "2026-01-03"]);
  });

  /** `bo` in `extra` more games with `ada` than the one `started` made. */
  async function moreGames(ada: Player, bo: Player, extra: number): Promise<void> {
    for (let i = 0; i < extra; i++) {
      const game = await createGame(h, ada, {
        gameType: "example",
        invitees: [{ email: bo.email }],
      });
      await transition(h, bo, game.id, "accept");
    }
  }

  it("caps each recipient's nudges a day without claiming or counting the rest (A6-S2-2)", async () => {
    h = gameHarness({ LIMIT_NUDGE_EMAILS_PER_USER_PER_DAY: "2" });
    const { ada, bo } = await started({ bo: true });
    await moreGames(ada, bo, 2);
    h.setTime(T0 + DAY);
    for (let run = 0; run < 4; run++) {
      await h.sweep();
      h.advance(15 * MINUTE);
    }
    expect(await nudgesTo(bo)).toHaveLength(2);
    expect(counted(`NUDGE_EMAILS_PER_USER_PER_DAY:${bo.id}`)).toBe(2);
    expect(
      h.query(
        "SELECT count(*) AS n FROM game_players WHERE user_id = ? AND last_nudged_at IS NOT NULL",
        bo.id,
      ),
    ).toEqual([{ n: 2 }]);
  });

  // Two seats a page: one seat per recipient is what lets Eve in. One: the recipients nudged
  // least recently come first.
  it.each([2, 1])(
    "a recipient held back by their own cap doesn't starve anyone else, %i a run (A6-P3-1)",
    async (nudgesPerRun) => {
      h = gameHarness({ LIMIT_NUDGE_EMAILS_PER_USER_PER_DAY: "1" }, { nudgesPerRun });
      // Bo: three games from T0, so two stay due and never nudged once Bo is at the cap.
      const { ada, bo } = await started({ bo: true });
      await moreGames(ada, bo, 2);
      h.setTime(T0 + DAY);
      await h.sweep();
      expect(await nudgesTo(bo)).toHaveLength(1);
      // Eve's turn starts half a day later, so her seat has waited less long than Bo's.
      h.setTime(T0 + 12 * HOUR);
      const eve = await started({ bo: true });
      h.setTime(T0 + 36 * HOUR);
      expect((await h.sweep()).nudges).toMatchObject({ sent: 1, skipped: nudgesPerRun - 1 });
      expect(await nudgesTo(eve.bo)).toHaveLength(1);
      expect(await nudgesTo(bo)).toHaveLength(1);
    },
  );

  it("names a deleted account's seat 'Deleted player' and a missing name 'New player' (02 §5, 04)", async () => {
    h = gameHarness();
    const deleted = await started({ bo: true });
    const unnamed = await started({ bo: true });
    h.exec("UPDATE game_players SET user_id = NULL WHERE user_id = ?", deleted.ada.id);
    h.exec("UPDATE users SET display_name = NULL WHERE id = ?", unnamed.ada.id);
    h.setTime(T0 + DAY);
    await h.sweep();
    const texts = [...(await nudgesTo(deleted.bo)), ...(await nudgesTo(unnamed.bo))].map(
      (email) => email.text.split("\n")[0],
    );
    expect(texts).toEqual([
      "It's your turn in your Example game with Deleted player. It has been waiting for you for over a day.",
      "It's your turn in your Example game with New player. It has been waiting for you for over a day.",
    ]);
  });

  it("sends nothing to a suspended user or a suppressed address", async () => {
    h = gameHarness();
    const { ada, bo } = await started({ ada: true, bo: true });
    h.exec("UPDATE users SET suspended_at = ? WHERE id = ?", T0, ada.id);
    const [row] = h.query("SELECT email_id FROM users WHERE id = ?", bo.id);
    h.exec(
      "INSERT INTO email_suppressions (email_hash, reason, created_at) VALUES (?, 'bounced', ?)",
      String(row?.["email_id"]),
      T0,
    );
    h.setTime(T0 + 2 * DAY);
    expect((await h.sweep()).nudges).toMatchObject({ due: 0 });
  });

  it("builds the email from the game's name, display names and public describe text only (T18)", async () => {
    h = gameHarness();
    const { ada, bo, gameId } = await started({ bo: true });
    await play(ada, gameId);
    h.setTime(T0 + DAY);
    await h.sweep();
    const [email] = await nudgesTo(bo);
    const token = tokenOf(email);
    const unsubscribe = `https://play.example.org${UNSUBSCRIBE}?t=${token}`;
    expect(email?.listUnsubscribe).toBe(unsubscribe);
    expect(email?.text).toBe(
      [
        "It's your turn in your Example game with Ada. It has been waiting for you for over a day.",
        "Last move: Ada played a card in round 1",
        `Play now: https://play.example.org/g/${gameId}`,
        "You're getting this because you turned on email nudges in Family Games: at most one a day for each game that's waiting for you.",
        "Turn them off in Settings: https://play.example.org/settings",
        `Or unsubscribe with one click: ${unsubscribe}`,
      ].join("\n\n") + "\n",
    );
    // No address of anyone but the recipient anywhere in it.
    const everything = JSON.stringify(email);
    expect(everything).not.toContain(ada.email);
    expect(everything.split(bo.email)).toHaveLength(2); // only the To
  });

  it("never shows a rack: neither player's tiles are in a words nudge (T18, A6-P-6)", async () => {
    h = gameHarness();
    const ada = await signUp(h, "Ada");
    const bo = await signUp(h, "Bo");
    await setNudges(ada, true);
    const created = await createGame(h, ada, {
      gameType: "words",
      invitees: [{ email: bo.email }],
    });
    expect((await transition(h, bo, created.id, "accept")).body.game.status).toBe("active");
    const racks: string[] = [];
    for (const player of [ada, bo]) {
      const { view } = await getGame(h, player, created.id);
      const rack = (view as { yourRack: string[] | null }).yourRack ?? [];
      expect(rack.length).toBeGreaterThan(0);
      racks.push(rack.join(""), rack.join(" "), rack.join(", "), JSON.stringify(rack));
    }
    h.setTime(T0 + DAY);
    await h.sweep();
    const [email] = (await h.emails()).filter(
      (sent) => sent.to === ada.email && sent.subject === "It's your turn in Words on Family Games",
    );
    expect(email).toBeDefined();
    for (const part of [email?.subject, email?.text, email?.html]) {
      const lower = (part ?? "").toLowerCase();
      for (const rack of racks) expect(lower).not.toContain(rack.toLowerCase());
    }
    expect(email?.text).toContain("It's your turn in your Words game with Bo.");
  });

  it("escapes hostile display names in the HTML and keeps them out of the subject (T7, T14)", async () => {
    h = gameHarness();
    const { ada, bo, gameId } = await started({ bo: true });
    h.exec("UPDATE users SET display_name = ? WHERE id = ?", '<b>Ada</b>"&', ada.id);
    await play(ada, gameId);
    h.setTime(T0 + DAY);
    await h.sweep();
    const [email] = await nudgesTo(bo);
    expect(email?.subject).toBe(SUBJECT);
    expect(email?.html).not.toContain("<b>Ada");
    expect(email?.html).toContain("&lt;b&gt;Ada&lt;/b&gt;&quot;&amp;");
  });

  it("keeps sweeping when the provider fails, logs no address, and doesn't retry that day", async () => {
    let fail = true;
    h = gameHarness(
      {},
      {
        wrapSender: (capture): EmailSender => ({
          send: (message) =>
            fail && message.subject === SUBJECT
              ? Promise.reject(new TypeError(`refused ${message.to}`))
              : capture.send(message),
        }),
      },
    );
    const { ada, bo } = await started({ ada: true, bo: true });
    h.setTime(T0 + DAY);
    const report = await h.sweep();
    expect(report.nudges).toEqual({ due: 2, sent: 0, failed: 2, skipped: 0, capped: false });
    const errors = h.logs.filter((line) => line["level"] === "error");
    expect(errors).toEqual([
      expect.objectContaining({ msg: "email nudge not sent", errorClass: "TypeError" }),
      expect.objectContaining({ msg: "email nudge not sent", errorClass: "TypeError" }),
    ]);
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain(ada.email);
    expect(logged).not.toContain(bo.email);
    fail = false;
    await h.sweep();
    expect(await nudgesTo(bo)).toHaveLength(0);
    h.advance(DAY);
    await h.sweep();
    expect(await nudgesTo(bo)).toHaveLength(1);
  });
});

describe("the unsubscribe route (05 §Email links, T17)", () => {
  async function nudged() {
    h = gameHarness();
    const game = await started({ bo: true });
    h.setTime(T0 + DAY);
    await h.sweep();
    const [email] = await nudgesTo(game.bo);
    return { ...game, token: tokenOf(email) };
  }

  it("GET shows a confirm page and changes nothing", async () => {
    const { bo, token } = await nudged();
    const response = await h.request("GET", `${UNSUBSCRIBE}?t=${token}`, undefined, {
      origin: null,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html/u);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
    const page = await response.text();
    expect(page).toContain("Turn off email nudges");
    expect(page).toContain(`action="${UNSUBSCRIBE}?t=${token}"`);
    expect(await nudgesOf(bo)).toBe(true);
  });

  it("POST from a mail client (cross-origin, form-encoded) turns nudges off, idempotently", async () => {
    const { bo, token } = await nudged();
    const first = await form(token);
    expect(first.status).toBe(200);
    const page = await first.text();
    expect(page).toContain("Email nudges are off");
    expect(await nudgesOf(bo)).toBe(false);
    expect(h.query("SELECT email_id FROM users WHERE id = ?", bo.id)).toEqual([{ email_id: null }]);
    const again = await form(token, null);
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(page);
    expect(await nudgesOf(bo)).toBe(false);
    // No more nudges, until the person turns them back on.
    h.advance(2 * DAY);
    await h.sweep();
    expect(await nudgesTo(bo)).toHaveLength(1);
    await setNudges(bo, true);
    await h.sweep();
    expect(await nudgesTo(bo)).toHaveLength(2);
  });

  it("answers a tampered, truncated or missing token with the same generic page and changes nothing", async () => {
    const { bo, token } = await nudged();
    const flipped = `${token.slice(0, 10)}${token[10] === "A" ? "B" : "A"}${token.slice(11)}`;
    const pages = new Set<string>();
    for (const bad of [flipped, token.slice(0, -2), `${token}AA`, "", "!!!"]) {
      for (const method of ["GET", "POST"] as const) {
        const response =
          method === "GET"
            ? await h.request("GET", `${UNSUBSCRIBE}?t=${encodeURIComponent(bad)}`)
            : await form(bad);
        expect(response.status).toBe(200);
        pages.add(await response.text());
      }
    }
    const missing = await h.request("POST", UNSUBSCRIBE, undefined, { origin: null });
    pages.add(await missing.text());
    expect(pages.size).toBe(1);
    expect([...pages][0]).toContain("This link isn&#39;t valid");
    expect(await nudgesOf(bo)).toBe(true);
  });

  it("a session cookie from another origin doesn't make the one-click POST fail (Origin-exempt)", async () => {
    const { bo, token } = await nudged();
    const response = await h.request("POST", `${UNSUBSCRIBE}?t=${token}`, undefined, {
      cookie: bo.cookie,
      origin: "https://mail.example",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      rawBody: "List-Unsubscribe=One-Click",
    });
    expect(response.status).toBe(200);
    expect(await nudgesOf(bo)).toBe(false);
  });

  it("an invites token suppresses the address and leaves the nudge setting alone (purpose-bound)", async () => {
    const { bo } = await nudged();
    const [row] = h.query("SELECT email_id FROM users WHERE id = ?", bo.id);
    const emailId = String(row?.["email_id"]);
    const keys = await deriveSubkeys(h.platform.config.appSecret);
    const token = await unsubscribeToken(keys, { purpose: "invites", emailId });
    const page = await (await h.request("GET", `${UNSUBSCRIBE}?t=${token}`)).text();
    expect(page).toContain("Don&#39;t send me invites again");
    for (let i = 0; i < 2; i++) {
      const response = await form(token);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("No more invitation emails");
    }
    expect(h.query("SELECT email_hash, reason FROM email_suppressions")).toEqual([
      { email_hash: emailId, reason: "unsubscribed" },
    ]);
    expect(await nudgesOf(bo)).toBe(true);
  });

  it("keeps an existing suppression's reason", async () => {
    h = gameHarness();
    const emailId = "a".repeat(64);
    h.exec(
      "INSERT INTO email_suppressions (email_hash, reason, created_at) VALUES (?, 'bounced', ?)",
      emailId,
      T0,
    );
    const keys = await deriveSubkeys(h.platform.config.appSecret);
    await form(await unsubscribeToken(keys, { purpose: "invites", emailId }));
    expect(h.query("SELECT reason FROM email_suppressions")).toEqual([{ reason: "bounced" }]);
  });

  it("a valid nudges token for an account that was deleted shows the same page and changes nothing", async () => {
    h = gameHarness();
    const ada = await signUp(h, "Ada");
    const gone = await signUp(h, "Gone");
    await setNudges(ada, true);
    await setNudges(gone, true);
    const [row] = h.query("SELECT email_id FROM users WHERE id = ?", gone.id);
    const keys = await deriveSubkeys(h.platform.config.appSecret);
    const token = await unsubscribeToken(keys, {
      purpose: "nudges",
      emailId: String(row?.["email_id"]),
    });
    // The account is deleted for real, through the step-up flow (06 §7).
    expect((await call(h, gone, "POST", "/api/v1/me/delete/otp", {})).status).toBe(202);
    const code = codeOf(await h.lastEmail(gone.email));
    expect((await call(h, gone, "DELETE", "/api/v1/me", { code })).status).toBe(204);
    expect(h.query("SELECT id FROM users WHERE id = ?", gone.id)).toEqual([]);
    const response = await form(token);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Email nudges are off");
    expect(await nudgesOf(ada)).toBe(true);
  });

  it("answers other methods with 404", async () => {
    const { token } = await nudged();
    const response = await h.request("PUT", `${UNSUBSCRIBE}?t=${token}`, {});
    expect(response.status).toBe(404);
  });
});

describe("the exemption (05 §Conventions)", () => {
  it("covers the unsubscribe path only", async () => {
    h = gameHarness();
    const response = await h.request("POST", `${UNSUBSCRIBE}/x`, undefined, {
      origin: "https://elsewhere.example",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      rawBody: "List-Unsubscribe=One-Click",
    });
    expect(response.status).toBe(403);
  });
});
