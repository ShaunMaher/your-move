/**
 * The "It's your turn" email nudges and the unsubscribe route (docs/spec/03-architecture.md §7,
 * §8; 05 §Email links; 08 T6, T14, T17, T18; alpha A6), end to end on the real app and a real
 * SQLite database: the setting, the sweep's rules, the email, and the one-click unsubscribe.
 */
import { type CapturedEmail, deriveSubkeys, type EmailSender } from "@your-move/server";
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
import { DAY, type Harness, HOUR, MINUTE, T0 } from "./test-harness.js";

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
    expect((await h.sweep()).nudges).toEqual({ due: 0, sent: 0, failed: 0, skipped: 0 });
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

  it("nudges for each game separately", async () => {
    h = gameHarness();
    const { ada, bo } = await started({ bo: true });
    const second = await createGame(h, ada, {
      gameType: "example",
      invitees: [{ email: bo.email }],
    });
    await transition(h, bo, second.id, "accept");
    h.setTime(T0 + DAY);
    expect((await h.sweep()).nudges?.sent).toBe(1 + 1);
    expect(await nudgesTo(bo)).toHaveLength(2);
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
    expect((await h.sweep()).nudges?.due).toBe(0);
  });

  it("skips a game whose rules version isn't installed (an orphan) without claiming it", async () => {
    h = gameHarness();
    const { gameId } = await started({ bo: true });
    h.exec("UPDATE games SET game_version = 99 WHERE id = ?", gameId);
    h.setTime(T0 + DAY);
    expect((await h.sweep()).nudges).toEqual({ due: 1, sent: 0, failed: 0, skipped: 1 });
    expect(
      h.query("SELECT last_nudged_at FROM game_players WHERE last_nudged_at IS NOT NULL"),
    ).toEqual([]);
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
    expect((await h.sweep()).nudges?.due).toBe(0);
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
        "It's your turn in your Example game with Ada. It has been waiting for you for a day.",
        "Last move: Ada played a card in round 1",
        `Play now: https://play.example.org/g/${gameId}`,
        "You're getting this because you turned on email nudges in Family Games: at most one a day for each game that's waiting for you.",
        "Turn them off in Settings: https://play.example.org/settings",
        `Or unsubscribe with one click: ${unsubscribe}`,
      ].join("\n\n") + "\n",
    );
    // No address, hand or other state anywhere in it.
    const everything = JSON.stringify(email);
    expect(everything).not.toContain(ada.email);
    expect(everything.split(bo.email)).toHaveLength(2); // only the To
    expect(everything).not.toContain('"hand"');
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
    expect(report.nudges).toEqual({ due: 2, sent: 0, failed: 2, skipped: 0 });
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

  it("a valid nudges token for an account that no longer exists changes nothing", async () => {
    h = gameHarness();
    const ada = await signUp(h, "Ada");
    await setNudges(ada, true);
    const keys = await deriveSubkeys(h.platform.config.appSecret);
    const token = await unsubscribeToken(keys, { purpose: "nudges", emailId: "b".repeat(64) });
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
