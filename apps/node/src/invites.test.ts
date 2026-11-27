/**
 * Email invites (alpha A17; docs/spec/06-auth.md §6.1, §6.3–§6.7, 02 §4 Invite claims, 03 §8, 05
 * `POST /api/v1/games`, 08 T3, T4): the invite email to an address with no account, the caps and
 * the suppression list, Q3's sameness for every typed address, the claim when someone completes
 * onboarding with the address (and by the sweep), and the sweep's lobby expiry. The real app on a
 * real SQLite database with the installed games; emails come from the capturing sender.
 */
import type { GameEnvelope } from "@your-move/sdk";
import {
  type CapturedEmail,
  deriveSubkeys,
  emailId as emailIdOf,
  type EmailSender,
  normaliseAddress,
  type Repositories,
} from "@your-move/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  call,
  createGame,
  type ErrorBody,
  freshEmail,
  gameHarness,
  getGame,
  playExampleToEnd,
  type Player,
  signUp,
  transition,
} from "./games-support.js";
import { DAY, type Harness, HOUR, MINUTE } from "./test-harness.js";

let h: Harness;
afterEach(() => {
  h.close();
});

const now = (): number => h.platform.now().getTime();
const code = (body: unknown): string | undefined => (body as Partial<ErrorBody>).error?.code;

/** Every invite email captured so far (subjects of the invite template). */
async function invitesTo(address: string): Promise<CapturedEmail[]> {
  return (await h.emails()).filter(
    (email) => email.to === address && email.subject.includes(" invited you to play "),
  );
}

/** An inviter past the new-account rate: signed up over 7 days ago (06 §6.6). */
async function seasoned(name: string): Promise<Player> {
  const player = await signUp(h, name);
  h.exec("UPDATE users SET created_at = ? WHERE id = ?", now() - 8 * DAY, player.id);
  return player;
}

/** Invites one address to a new words game; the creator's response body. */
async function invite(creator: Player, email: string, extra: Record<string, unknown> = {}) {
  const created = await call<{ game: GameEnvelope }>(h, creator, "POST", "/api/v1/games", {
    gameType: "words",
    invitees: [{ email }],
    ...extra,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body;
}

/** The response with what differs between any two games blanked out. */
const shape = (body: unknown) =>
  JSON.parse(
    JSON.stringify(body)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "<id>")
      .replace(/"invitedAs":"[^"]*"/gu, '"invitedAs":"<address>"')
      .replace(/"(createdAt|lastActionAt)":[0-9]+/gu, '"$1":0'),
  ) as unknown;

async function emailIdOfAddress(address: string): Promise<string> {
  const keys = await deriveSubkeys(h.platform.config.appSecret);
  const normalised = normaliseAddress(address);
  if (normalised === null) throw new Error("invalid test address");
  return emailIdOf(keys, normalised);
}

async function suppress(address: string, reason: string): Promise<void> {
  h.exec(
    "INSERT INTO email_suppressions (email_hash, reason, created_at) VALUES (?, ?, ?)",
    await emailIdOfAddress(address),
    reason,
    now(),
  );
}

/** One-click unsubscribe, as a mail client posts it (RFC 8058). */
function oneClick(url: string) {
  const parsed = new URL(url);
  return h.request("POST", `${parsed.pathname}${parsed.search}`, undefined, {
    origin: null,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    rawBody: "List-Unsubscribe=One-Click",
  });
}

/** The repositories, each call's name (and for list arguments, how many) recorded. */
function recording(repos: Repositories, calls: string[]): Repositories {
  const wrap = <T extends object>(group: string, repo: T): T =>
    new Proxy(repo, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const first = args[0];
          calls.push(
            `${group}.${String(key)}${Array.isArray(first) ? `(${String(first.length)})` : ""}`,
          );
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  return Object.fromEntries(
    Object.entries(repos).map(([group, repo]) => [group, wrap(group, repo as object)]),
  ) as unknown as Repositories;
}

/** The sum of every rate-limit counter: what a request adds to them, real or `silent`. */
const counted = (): number =>
  Number(h.query("SELECT coalesce(sum(count), 0) AS n FROM rate_limits")[0]?.["n"]);

const playerRow = (gameId: string, column: "user_id" | "invite_email" | "delivery") =>
  h.query(
    `SELECT ${column} AS value FROM game_players WHERE game_id = ? AND joined_via IS NOT 'creator'`,
    gameId,
  )[0]?.["value"];

describe("the invite email (06 §6.3)", () => {
  it("tells an address with no account who invited it to what and how to join, and nothing of the game", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const address = freshEmail();
    const { game } = await invite(ada, address, { turnTimeoutDays: 5 });
    const [mail, ...more] = await invitesTo(address);
    expect(more).toEqual([]);
    expect(mail?.subject).toBe("Ada invited you to play Words on Family Games");
    const unsubscribe = mail?.listUnsubscribe ?? "";
    expect(unsubscribe).toMatch(
      /^https:\/\/play\.example\.org\/api\/v1\/email\/unsubscribe\?t=[A-Za-z0-9_-]+$/u,
    );
    expect(mail?.text).toBe(
      [
        `Ada (${ada.email}) has invited you to play Words on Family Games.`,
        "Each player has 5 days for each move. The invitation stays open for 14 days.",
        "To join, sign in with this email address at https://play.example.org",
        "There's no password: Family Games emails you a sign-in code. Then choose the name other players will see, and the invitation will be waiting in your list of games.",
        'On a phone you can add Family Games to your home screen. On an iPhone, open the link in Safari, tap Share, then "Add to Home Screen". On Android, open it in Chrome and choose "Install app" or "Add to Home screen".',
        "If you don't know Ada or don't want to play, you can ignore this email.",
        `Don't send me invites again: ${unsubscribe}`,
      ].join("\n\n") + "\n",
    );
    // Nothing of the game itself: not its id, not its options.
    const options = Object.values(game.options as Record<string, unknown>).filter(
      (value): value is string => typeof value === "string",
    );
    expect(options.length).toBeGreaterThan(0);
    for (const secret of [game.id, ...options]) {
      expect(mail?.text).not.toContain(secret);
      expect(mail?.html).not.toContain(secret);
    }
    expect(h.query("SELECT sent_at FROM invites WHERE game_id = ?", game.id)).toEqual([
      { sent_at: now() },
    ]);
  });

  it("escapes the inviter's name in the HTML part", async () => {
    h = gameHarness();
    const ann = await seasoned("Ann <b> & Co");
    const address = freshEmail();
    await invite(ann, address);
    const [mail] = await invitesTo(address);
    expect(mail?.subject).toBe("Ann <b> & Co invited you to play Words on Family Games");
    expect(mail?.html).toContain("Ann &lt;b&gt; &amp; Co (");
    expect(mail?.html).not.toContain("<b>");
  });

  it("goes to an account that hasn't finished onboarding too, but never to one that has", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const halfway = await signUp(h, null);
    const known = await signUp(h, "Bo");
    await invite(ada, halfway.email);
    h.advance(MINUTE);
    const knownGame = await invite(ada, known.email);
    expect(await invitesTo(halfway.email)).toHaveLength(1);
    expect(await invitesTo(known.email)).toEqual([]);
    expect(h.query("SELECT sent_at FROM invites WHERE game_id = ?", knownGame.game.id)).toEqual([
      { sent_at: null },
    ]);
  });

  it("unsubscribes the address with one click: later invitations still seat it, and send nothing", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const address = freshEmail();
    const first = await invite(ada, address);
    const [mail] = await invitesTo(address);
    const answer = await oneClick(mail?.listUnsubscribe ?? "");
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain("No more invitation emails");
    expect(h.query("SELECT reason FROM email_suppressions")).toEqual([{ reason: "unsubscribed" }]);
    h.advance(HOUR);
    const second = await invite(ada, address);
    expect(await invitesTo(address)).toHaveLength(1);
    expect(shape(second)).toEqual(shape(first));
  });

  it("is never sent to a suppressed address, whatever the reason", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    for (const reason of ["unsubscribed", "bounced", "complained"]) {
      const address = freshEmail();
      await suppress(address, reason);
      await invite(ada, address);
      h.advance(HOUR);
      expect(await invitesTo(address), reason).toEqual([]);
    }
  });

  it("logs a failed send by class, and the creator's answer doesn't change", async () => {
    const failing = (capture: EmailSender): EmailSender => ({
      send: (message) =>
        message.subject.includes(" invited you ")
          ? Promise.reject(new TypeError(`refused ${message.to}`))
          : capture.send(message),
    });
    h = gameHarness({}, { wrapSender: failing });
    const ada = await seasoned("Ada");
    const address = freshEmail();
    await invite(ada, address);
    await h.drain();
    const errors = h.logs.filter((line) => line["level"] === "error");
    expect(errors).toEqual([
      expect.objectContaining({ msg: "invite email not sent", errorClass: "TypeError" }),
    ]);
    expect(JSON.stringify(h.logs)).not.toContain(address);
  });
});

describe("invite-email caps (06 §6.6, 08 §4)", () => {
  /** Invites a fresh address in a new game each hour (inside the email-invitee caps). */
  async function inviteFresh(creator: Player, count: number): Promise<string[]> {
    const addresses: string[] = [];
    for (let i = 0; i < count; i++) {
      const address = freshEmail();
      await invite(creator, address);
      addresses.push(address);
      h.advance(HOUR);
    }
    return addresses;
  }

  const mailed = async (addresses: readonly string[]) =>
    Promise.all(addresses.map(async (address) => (await invitesTo(address)).length));

  it("sends an inviter's first 5 a day; the 6th address is seated and not mailed", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const addresses = await inviteFresh(ada, 6);
    expect(await mailed(addresses)).toEqual([1, 1, 1, 1, 1, 0]);
    expect(
      h.query("SELECT count(*) AS n FROM game_players WHERE invite_email IS NOT NULL")[0]?.["n"],
    ).toBe(6);
    // A day later the inviter's allowance is back.
    h.advance(2 * DAY);
    expect(await mailed(await inviteFresh(ada, 1))).toEqual([1]);
  });

  it("caps an inviter at 20 in 30 days", async () => {
    h = gameHarness({ LIMIT_INVITE_EMAILS_INVITER_30D: "3" });
    const ada = await seasoned("Ada");
    const addresses = await inviteFresh(ada, 2);
    h.advance(2 * DAY);
    addresses.push(...(await inviteFresh(ada, 2)));
    expect(await mailed(addresses)).toEqual([1, 1, 1, 0]);
  });

  it("gives an account under 7 days old that hasn't finished a game 2 a day; a finished game lifts it", async () => {
    h = gameHarness();
    const young = await signUp(h, "Yan");
    expect(await mailed(await inviteFresh(young, 3))).toEqual([1, 1, 0]);

    const other = await signUp(h, "Ola");
    const opponent = await signUp(h, "Opp");
    const game = await createGame(h, other, {
      gameType: "example",
      invitees: [{ email: opponent.email }],
    });
    expect((await transition(h, opponent, game.id, "accept")).status).toBe(200);
    await playExampleToEnd(h, game.id, [other, opponent]);
    h.advance(HOUR);
    expect(await mailed(await inviteFresh(other, 3))).toEqual([1, 1, 1]);
  });

  it("mails one address at most 3 times in 30 days, across inviters", async () => {
    h = gameHarness();
    const address = freshEmail();
    for (const name of ["Ada", "Bo", "Cy", "Di"]) {
      await invite(await seasoned(name), address);
      h.advance(MINUTE);
    }
    expect(await invitesTo(address)).toHaveLength(3);
    h.advance(31 * DAY);
    await invite(await seasoned("Ed"), address);
    expect(await invitesTo(address)).toHaveLength(4);
  });

  it("counts every typed address toward the creator's email-invitee cap, whatever it is (08 §4)", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const known = await signUp(h, "Bo");
    const halfway = await signUp(h, null);
    // Five an hour: a known address, an un-onboarded one and three nobody holds.
    for (const address of [known.email, halfway.email, freshEmail(), freshEmail(), freshEmail()]) {
      await invite(ada, address);
    }
    const last = freshEmail();
    const over = await call(h, ada, "POST", "/api/v1/games", {
      gameType: "words",
      invitees: [{ email: last }],
    });
    expect([over.status, code(over.body)]).toEqual([429, "RATE_LIMITED"]);
    expect(h.query("SELECT count(*) AS n FROM games")[0]?.["n"]).toBe(5);
    expect(await invitesTo(last)).toEqual([]);
  });

  it("caps the instance a day, with one alert", async () => {
    h = gameHarness({ LIMIT_INVITE_EMAILS_GLOBAL_DAY: "2" });
    const addresses: string[] = [];
    for (const name of ["Ada", "Bo", "Cy", "Di"]) {
      const address = freshEmail();
      await invite(await seasoned(name), address);
      addresses.push(address);
    }
    expect(await mailed(addresses)).toEqual([1, 1, 0, 0]);
    const alerts = h.logs.filter((line) => line["alert"] === "INVITE_EMAILS_GLOBAL_DAY");
    expect(alerts).toHaveLength(1);
  });
});

describe("Q3: every typed address alike (06 §6.1)", () => {
  it("answers, reads, writes and schedules the same for a known, unknown, un-onboarded, suppressed and capped address", async () => {
    const calls: string[] = [];
    h = gameHarness({}, { wrapRepos: (repos) => recording(repos, calls) });
    const ada = await seasoned("Ada");
    const known = await signUp(h, "Bo");
    const halfway = await signUp(h, null);
    const suppressed = freshEmail();
    await suppress(suppressed, "unsubscribed");
    // Three invite emails from others already: this address is over its own cap.
    const capped = freshEmail();
    for (const name of ["Cy", "Di", "Ed"]) await invite(await seasoned(name), capped);
    const cases = {
      known: known.email,
      unknown: freshEmail(),
      halfway: halfway.email,
      suppressed,
      capped,
    };
    const seen: Record<string, unknown> = {};
    for (const [name, address] of Object.entries(cases)) {
      h.advance(HOUR);
      await h.drain();
      calls.length = 0;
      const before = {
        counted: counted(),
        scheduled: h.backgroundScheduled(),
        logs: h.logs.length,
      };
      const body = await invite(ada, address);
      const request = h.logs.slice(before.logs).find((line) => line["msg"] === "request");
      seen[name] = {
        shape: shape(body),
        // The session's last-seen refresh runs alongside, so its place in the order varies.
        calls: calls.filter((name) => name !== "sessions.touch"),
        counted: counted() - before.counted,
        scheduled: h.backgroundScheduled() - before.scheduled,
        request: Object.keys(request ?? {}).sort(),
        status: request?.["status"],
      };
    }
    for (const name of Object.keys(cases)) expect(seen[name], name).toEqual(seen["known"]);
    // Only the email-invite seats that may be mailed were.
    const mailedTo = await Promise.all(
      Object.values(cases).map(async (address) => (await invitesTo(address)).length),
    );
    expect(mailedTo).toEqual([0, 1, 1, 0, 3]);
  });

  it("refuses a literal duplicate, the creator's own address and an invalid one before counting or sending anything", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const address = freshEmail();
    for (const [invitees, expected] of [
      [[{ email: address }, { email: address.toUpperCase() }], "INVALID_INVITEES"],
      [[{ email: ada.email }], "CANNOT_PLAY_SELF"],
      [[{ email: "not-an-address" }], "INVALID_INVITEES"],
    ] as const) {
      const before = { counted: counted(), scheduled: h.backgroundScheduled() };
      const answer = await call(h, ada, "POST", "/api/v1/games", {
        gameType: "example",
        seats: 3,
        invitees,
      });
      expect([answer.status, code(answer.body)]).toEqual([400, expected]);
      // Only the per-user write limit counted; no background task, no game, no email.
      expect(counted() - before.counted).toBe(1);
      expect(h.backgroundScheduled()).toBe(before.scheduled);
    }
    expect(h.query("SELECT count(*) AS n FROM games")[0]?.["n"]).toBe(0);
    expect(await invitesTo(address)).toEqual([]);
  });

  it("seats the address of someone already picked as an inert email-only seat, answered and worked like any other", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const bo = await signUp(h, "Bo");
    for (const [one, other] of [
      [ada.id, bo.id],
      [bo.id, ada.id],
    ]) {
      h.exec(
        "INSERT INTO past_opponents (user_id, other_id, last_finished_at) VALUES (?, ?, ?)",
        one ?? "",
        other ?? "",
        now(),
      );
    }
    const body = (email: string) => ({
      gameType: "example",
      seats: 3,
      invitees: [{ userId: bo.id }, { email }],
    });
    const control = await call<{ game: GameEnvelope }>(
      h,
      ada,
      "POST",
      "/api/v1/games",
      body(freshEmail()),
    );
    h.advance(HOUR);
    const duplicate = await call<{ game: GameEnvelope }>(
      h,
      ada,
      "POST",
      "/api/v1/games",
      body(bo.email),
    );
    expect(duplicate.status).toBe(201);
    expect(shape(duplicate.body)).toEqual(shape(control.body));
    expect(
      h.query(
        "SELECT user_id, delivery FROM game_players WHERE game_id = ? AND invite_email IS NOT NULL",
        duplicate.body.game.id,
      ),
    ).toEqual([{ user_id: null, delivery: "inert" }]);
    expect(await invitesTo(bo.email)).toEqual([]);
  });
});

describe("claims (06 §6.4)", () => {
  it("onboarding with the address claims the seat: the new user's invitation, unread; nothing changes for the creator", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const address = freshEmail();
    const { game } = await invite(ada, address);
    const creatorBefore = await getGame(h, ada, game.id);
    const listBefore = await call(h, ada, "GET", "/api/v1/games");

    // Signing in alone claims nothing: the account isn't onboarded yet.
    const cookie = await h.signIn(address);
    expect(playerRow(game.id, "user_id")).toBeNull();
    const onboarded = await h.request("PATCH", "/api/v1/me", { displayName: "Bo" }, { cookie });
    expect(onboarded.status).toBe(200);
    const bo: Player = {
      email: address,
      cookie,
      id: String(h.query("SELECT id FROM users WHERE email = ?", address)[0]?.["id"]),
      name: "Bo",
    };
    expect(playerRow(game.id, "user_id")).toBe(bo.id);
    // The creator's view of the lobby and their list are exactly as before (02 §4).
    expect(await getGame(h, ada, game.id)).toEqual(creatorBefore);
    expect(await call(h, ada, "GET", "/api/v1/games")).toEqual(listBefore);
    // The invitation is Bo's: listed, unread, normal.
    const invitations = await call<{ games: { id: string; unread: boolean }[] }>(
      h,
      bo,
      "GET",
      "/api/v1/games?invitations=true",
    );
    expect(invitations.body.games).toEqual([
      expect.objectContaining({ id: game.id, unread: true, yourInvitation: "normal" }),
    ]);
    // Accepting fills the lobby, which starts; now the creator sees Bo by name.
    const accepted = await transition(h, bo, game.id, "accept");
    expect(accepted.body.game.status).toBe("active");
    const after = await getGame(h, ada, game.id);
    expect(after.game.players.map((player) => player.displayName)).toContain("Bo");
  });

  it("claims for an account that hadn't finished onboarding when it was invited", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const halfway = await signUp(h, null);
    const { game } = await invite(ada, halfway.email);
    expect(playerRow(game.id, "user_id")).toBeNull();
    const done = await call(h, halfway, "PATCH", "/api/v1/me", { displayName: "Hal" });
    expect(done.status).toBe(200);
    expect(playerRow(game.id, "user_id")).toBe(halfway.id);
    expect((await getGame(h, halfway, game.id)).game.yourInvitation).toBe("normal");
  });

  it("keeps the delivery the inbound cap gave the seat at creation", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const address = freshEmail();
    const first = await invite(ada, address);
    h.advance(MINUTE);
    const second = await invite(ada, address);
    expect(playerRow(second.game.id, "delivery")).toBe("hidden");
    const bo = await signUp(h, "Bo", address);
    const listed = async (query: string) =>
      (
        await call<{ games: { id: string }[] }>(h, bo, "GET", `/api/v1/games${query}`)
      ).body.games.map((row) => row.id);
    expect(await listed("?invitations=true")).toEqual([first.game.id]);
    expect(await listed("?invitations=hidden")).toEqual([second.game.id]);
  });

  it("makes the claimed row inert when the claimant and anyone in the game have a block", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const address = freshEmail();
    const { game } = await invite(ada, address);
    const halfway = await signUp(h, null, address);
    h.exec(
      "INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)",
      ada.id,
      halfway.id,
      now(),
    );
    const creatorBefore = await getGame(h, ada, game.id);
    expect((await call(h, halfway, "PATCH", "/api/v1/me", { displayName: "Hal" })).status).toBe(
      200,
    );
    expect(playerRow(game.id, "delivery")).toBe("inert");
    expect(playerRow(game.id, "user_id")).toBe(halfway.id);
    expect((await call(h, halfway, "GET", `/api/v1/games/${game.id}`)).status).toBe(404);
    expect(await getGame(h, ada, game.id)).toEqual(creatorBefore);
  });

  it("never claims into a lobby that is due to expire", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const address = freshEmail();
    const { game } = await invite(ada, address);
    h.advance(14 * DAY);
    const bo = await signUp(h, "Bo", address);
    expect(playerRow(game.id, "user_id")).toBeNull();
    expect((await call(h, bo, "GET", `/api/v1/games/${game.id}`)).status).toBe(404);
  });

  it("is never fatal to onboarding: a failed claim is logged by class and the sweep claims it later", async () => {
    let failures = 0;
    h = gameHarness(
      {},
      {
        wrapRepos: (repos) => ({
          ...repos,
          invites: {
            ...repos.invites,
            claimable: (...args) =>
              failures-- > 0
                ? Promise.reject(new RangeError("database is busy"))
                : repos.invites.claimable(...args),
          },
        }),
      },
    );
    const ada = await seasoned("Ada");
    const address = freshEmail();
    const { game } = await invite(ada, address);
    failures = 1;
    const bo = await signUp(h, "Bo", address);
    expect(playerRow(game.id, "user_id")).toBeNull();
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "invite claim at onboarding failed",
        errorClass: "RangeError",
      }),
    );
    expect(JSON.stringify(h.logs)).not.toContain("database is busy");
    const report = await h.sweep();
    expect(report.claims).toEqual({ claimed: 1, skipped: 0 });
    expect(playerRow(game.id, "user_id")).toBe(bo.id);
  });

  it("the sweep claims a seat whose invitee finished onboarding while the game was created, never a suspended user's", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const racing = await signUp(h, null);
    const suspended = await signUp(h, null);
    const raced = await invite(ada, racing.email);
    h.advance(MINUTE);
    const held = await invite(ada, suspended.email);
    // Their onboarding committed before the game was inserted, and claimed nothing then.
    h.exec(
      "UPDATE users SET onboarded_at = ?, display_name = 'Ray' WHERE id IN (?, ?)",
      now(),
      racing.id,
      suspended.id,
    );
    h.exec("UPDATE users SET suspended_at = ? WHERE id = ?", now(), suspended.id);
    const before = await getGame(h, ada, raced.game.id);
    const report = await h.sweep();
    expect(report.claims).toEqual({ claimed: 1, skipped: 0 });
    expect(playerRow(raced.game.id, "user_id")).toBe(racing.id);
    expect(playerRow(held.game.id, "user_id")).toBeNull();
    // Invisible to the creator: no version bump, nothing else.
    expect(await getGame(h, ada, raced.game.id)).toEqual(before);
    // Done once: the next run finds nothing.
    expect((await h.sweep()).claims).toEqual({ claimed: 0, skipped: 0 });
  });
});

describe("lobby expiry by the sweep (03 §8, 06 §6.5)", () => {
  it("expires a lobby nobody comes back to and clears its typed address", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const { game } = await invite(ada, freshEmail());
    h.advance(14 * DAY - MINUTE);
    expect((await h.sweep()).lobbies).toBe(0);
    expect(h.query("SELECT status FROM games WHERE id = ?", game.id)).toEqual([
      { status: "lobby" },
    ]);
    h.advance(MINUTE);
    expect((await h.sweep()).lobbies).toBe(1);
    expect(h.query("SELECT status, end_reason FROM games WHERE id = ?", game.id)).toEqual([
      { status: "expired", end_reason: "expired" },
    ]);
    expect(playerRow(game.id, "invite_email")).toBeNull();
    // The invites row keeps only the emailId, for the counts (04 `invites`).
    expect(
      h.query("SELECT email_hash FROM invites WHERE game_id = ?", game.id)[0]?.["email_hash"],
    ).toMatch(/^[0-9a-f]{64}$/u);
    expect((await h.sweep()).lobbies).toBe(0);
  });
});
