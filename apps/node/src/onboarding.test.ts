/**
 * Onboarding's age confirmation, the re-prompt after a `MIN_AGE` rise and the under-age exit
 * (alpha A21; docs/spec/06-auth.md §5, 05 `PATCH /api/v1/me` and `POST /api/v1/me/under-age`, 04
 * `users.age_attested_*` and §Account deletion, 08 §5, Q20). The real app on a real SQLite
 * database with the installed games.
 */
import type { GameEnvelope } from "@your-move/sdk";
import { deriveSubkeys, emailId as emailIdOf, normaliseAddress } from "@your-move/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  call,
  type ErrorBody,
  gameHarness,
  getGame,
  playExampleToEnd,
  type Player,
  signUp,
  transition,
} from "./games-support.js";
import { DAY, type Harness, MINUTE } from "./test-harness.js";

let h: Harness;
afterEach(() => {
  h.close();
});

const now = (): number => h.platform.now().getTime();

interface MeBody {
  readonly displayName: string | null;
  readonly ageAttested: boolean;
  readonly needsOnboarding: boolean;
}

const patchMe = (player: Player, body: Record<string, unknown>) =>
  call<MeBody & ErrorBody>(h, player, "PATCH", "/api/v1/me", body);
const me = (player: Player) => call<MeBody>(h, player, "GET", "/api/v1/me");
const underAge = (player: Player) =>
  h.request("POST", "/api/v1/me/under-age", {}, { cookie: player.cookie });

/** The stored onboarding columns of a user. */
function userRow(id: string): Record<string, unknown> | undefined {
  return h.query(
    "SELECT display_name, onboarded_at, age_attested_at, age_attested_min_age FROM users WHERE id = ?",
    id,
  )[0];
}

/** Makes an onboarded player a re-prompted one: no confirmation for the current `MIN_AGE`. */
function forgetAge(player: Player, minAge: number | null = null): void {
  h.exec("UPDATE users SET age_attested_min_age = ? WHERE id = ?", minAge, player.id);
}

/** A second session of the same person (another device). */
async function otherDevice(player: Player): Promise<Player> {
  return { ...player, cookie: await h.signIn(player.email) };
}

async function emailIdOfAddress(address: string): Promise<string> {
  const keys = await deriveSubkeys(h.platform.config.appSecret);
  const normalised = normaliseAddress(address);
  if (normalised === null) throw new Error("invalid test address");
  return emailIdOf(keys, normalised);
}

/** An inviter past the new-account invite-email rate (06 §6.6). */
async function seasoned(name: string): Promise<Player> {
  const player = await signUp(h, name);
  h.exec("UPDATE users SET created_at = ? WHERE id = ?", now() - 8 * DAY, player.id);
  return player;
}

/** A new words lobby inviting `email`; the creator's response body. */
async function invite(creator: Player, email: string) {
  const created = await call<{ game: GameEnvelope }>(h, creator, "POST", "/api/v1/games", {
    gameType: "words",
    invitees: [{ email }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.game;
}

function seatOf(gameId: string, column: string): unknown {
  return h.query(
    `SELECT ${column} FROM game_players WHERE game_id = ? AND joined_via IS NULL`,
    gameId,
  )[0]?.[column];
}

/** Invite emails captured for an address. */
async function invitesTo(address: string) {
  return (await h.emails()).filter(
    (email) => email.to === address && email.subject.includes(" invited you to play "),
  );
}

describe("the age confirmation (06 §5, 05 PATCH /api/v1/me)", () => {
  it("with the display name in one request, completes onboarding and stores its time and MIN_AGE", async () => {
    h = gameHarness();
    const sam = await signUp(h, null);
    expect((await me(sam)).body).toMatchObject({ ageAttested: false, needsOnboarding: true });
    h.advance(MINUTE);
    const done = await patchMe(sam, { displayName: "Sam", ageAttested: true });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      displayName: "Sam",
      ageAttested: true,
      needsOnboarding: false,
    });
    expect(userRow(sam.id)).toEqual({
      display_name: "Sam",
      onboarded_at: now(),
      age_attested_at: now(),
      age_attested_min_age: 13,
    });
    // Nothing about age beyond that, and no rename logged.
    expect(
      h.query(
        "SELECT type FROM auth_events WHERE user_id = ? AND type = 'display_name_changed'",
        sam.id,
      ),
    ).toEqual([]);
  });

  it("stores MIN_AGE as configured", async () => {
    h = gameHarness({ MIN_AGE: "16" });
    const sam = await signUp(h, null);
    await patchMe(sam, { displayName: "Sam", ageAttested: true });
    expect(userRow(sam.id)).toMatchObject({ age_attested_min_age: 16 });
  });

  it.each([
    ["the name first", [{ displayName: "Sam" }, { ageAttested: true }]],
    ["the age first", [{ ageAttested: true }, { displayName: "Sam" }]],
  ] as const)(
    "may come apart (%s): onboarding completes with the second",
    async (_order, steps) => {
      h = gameHarness();
      const sam = await signUp(h, null);
      const [first, second] = steps;
      const halfway = await patchMe(sam, first);
      expect(halfway.status).toBe(200);
      expect(halfway.body.needsOnboarding).toBe(true);
      expect(userRow(sam.id)?.["onboarded_at"]).toBeNull();
      // Still gated until both are done.
      expect((await call(h, sam, "GET", "/api/v1/games")).status).toBe(403);
      const done = await patchMe(sam, second);
      expect(done.body).toMatchObject({ displayName: "Sam", needsOnboarding: false });
      expect(userRow(sam.id)?.["onboarded_at"]).toBe(now());
      // A name set before onboarding completed was no rename: the 3-per-30-days budget is whole.
      for (const name of ["Sam A", "Sam B", "Sam C"]) {
        expect((await patchMe(sam, { displayName: name })).status).toBe(200);
      }
      expect((await patchMe(sam, { displayName: "Sam D" })).status).toBe(429);
    },
  );

  it("claims email-invite seats only when onboarding completes, not at the name alone", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const bo = await signUp(h, null);
    const game = await invite(ada, bo.email);
    await patchMe(bo, { displayName: "Bo" });
    expect(seatOf(game.id, "user_id")).toBeNull();
    await patchMe(bo, { ageAttested: true });
    expect(seatOf(game.id, "user_id")).toBe(bo.id);
    expect((await getGame(h, bo, game.id)).game.yourInvitation).toBe("normal");
  });

  it("a refused name stores nothing, the confirmation included", async () => {
    h = gameHarness();
    const sam = await signUp(h, null);
    const refused = await patchMe(sam, { displayName: "visit example.com", ageAttested: true });
    expect(refused.status).toBe(400);
    expect(userRow(sam.id)).toEqual({
      display_name: null,
      onboarded_at: null,
      age_attested_at: null,
      age_attested_min_age: null,
    });
  });

  it.each([false, "yes", 1, null])("accepts only true (%j is a 400)", async (value) => {
    h = gameHarness();
    const sam = await signUp(h, null);
    expect((await patchMe(sam, { displayName: "Sam", ageAttested: value })).status).toBe(400);
  });

  it("a repeat changes nothing: the first confirmation's time stays", async () => {
    h = gameHarness();
    const sam = await signUp(h, "Sam");
    const first = userRow(sam.id)?.["age_attested_at"];
    h.advance(DAY);
    expect((await patchMe(sam, { ageAttested: true })).status).toBe(200);
    expect(userRow(sam.id)?.["age_attested_at"]).toBe(first);
  });
});

describe("the re-prompt after a MIN_AGE rise (06 §5)", () => {
  it("an onboarded account with no confirmation (from before it existed) is re-prompted", async () => {
    h = gameHarness();
    const sam = await signUp(h, "Sam");
    const onboardedAt = userRow(sam.id)?.["onboarded_at"];
    forgetAge(sam);
    expect((await me(sam)).body).toMatchObject({
      displayName: "Sam",
      ageAttested: false,
      needsOnboarding: true,
    });
    // onboarded_at is never cleared.
    expect(userRow(sam.id)?.["onboarded_at"]).toBe(onboardedAt);
  });

  it("an account that confirmed a lower MIN_AGE is re-prompted, and confirms the new one alone", async () => {
    h = gameHarness({ MIN_AGE: "16" });
    const sam = await signUp(h, "Sam");
    const onboardedAt = userRow(sam.id)?.["onboarded_at"];
    forgetAge(sam, 13);
    expect((await me(sam)).body.needsOnboarding).toBe(true);
    expect((await call(h, sam, "GET", "/api/v1/games")).status).toBe(403);
    h.advance(MINUTE);
    const confirmed = await patchMe(sam, { ageAttested: true });
    expect(confirmed.body).toMatchObject({ displayName: "Sam", needsOnboarding: false });
    expect(userRow(sam.id)).toEqual({
      display_name: "Sam",
      onboarded_at: onboardedAt,
      age_attested_at: now(),
      age_attested_min_age: 16,
    });
    expect((await call(h, sam, "GET", "/api/v1/games")).status).toBe(200);
  });

  it("an account that confirmed a higher MIN_AGE than now in force is not re-prompted", async () => {
    h = gameHarness();
    const sam = await signUp(h, "Sam");
    forgetAge(sam, 16);
    expect((await me(sam)).body).toMatchObject({ ageAttested: true, needsOnboarding: false });
  });

  it("gets 403 ONBOARDING_REQUIRED from every gated endpoint, add-player and rematch included", async () => {
    h = gameHarness();
    const [ann, bob, cy] = [await signUp(h, "Ann"), await signUp(h, "Bob"), await signUp(h, "Cy")];
    // A finished link game Ann created and Bob joined by link, so add-player and rematch apply.
    const created = await call<{ game: GameEnvelope; joinLinkUrl?: string }>(
      h,
      ann,
      "POST",
      "/api/v1/games",
      { gameType: "example", seats: 2, invitees: [], joinLink: true },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const finished = created.body.game.id;
    const token = /#([A-Za-z0-9_-]{22})$/u.exec(created.body.joinLinkUrl ?? "")?.[1] ?? "";
    expect((await call(h, bob, "POST", "/api/v1/join", { token })).status).toBe(200);
    expect((await transition(h, ann, finished, "start")).status).toBe(200);
    await playExampleToEnd(h, finished, [ann, bob]);
    // A lobby inviting Ann, and a live link for her to look up.
    const lobby = await call<{ game: GameEnvelope; joinLinkUrl?: string }>(
      h,
      cy,
      "POST",
      "/api/v1/games",
      { gameType: "example", seats: 3, invitees: [{ email: ann.email }], joinLink: true },
    );
    expect(lobby.status, JSON.stringify(lobby.body)).toBe(201);
    const lobbyToken = /#([A-Za-z0-9_-]{22})$/u.exec(lobby.body.joinLinkUrl ?? "")?.[1] ?? "";
    const lobbyVersion = (await getGame(h, ann, lobby.body.game.id)).game.version;
    // A lobby of Ann's own, with a link she may still turn off but not make anew.
    const own = await call<{ game: GameEnvelope }>(h, ann, "POST", "/api/v1/games", {
      gameType: "example",
      seats: 3,
      invitees: [{ email: cy.email }],
      joinLink: true,
    });
    expect(own.status, JSON.stringify(own.body)).toBe(201);

    forgetAge(ann);
    const counts = () => ({
      games: h.query("SELECT count(*) AS n FROM games")[0]?.["n"],
      links: h.query("SELECT count(*) AS n FROM join_links")[0]?.["n"],
    });
    const before = counts();
    const gated: [string, string, unknown][] = [
      ["GET", "/api/v1/games", undefined],
      [
        "POST",
        "/api/v1/games",
        { gameType: "example", seats: 2, invitees: [{ email: bob.email }] },
      ],
      ["POST", `/api/v1/games/${lobby.body.game.id}/accept`, { expectedVersion: lobbyVersion }],
      ["POST", "/api/v1/join/lookup", { token: lobbyToken }],
      ["POST", "/api/v1/join", { token: lobbyToken }],
      ["GET", "/api/v1/players/recent", undefined],
      ["POST", `/api/v1/games/${finished}/add-player`, { userId: bob.id }],
      ["POST", `/api/v1/games/${finished}/rematch`, {}],
      // Making or rotating a join link brings new people in (A21-S-5).
      ["POST", `/api/v1/games/${own.body.game.id}/join-link`, {}],
    ];
    for (const [method, path, body] of gated) {
      const answer = await call<ErrorBody>(h, ann, method, path, body);
      expect([method, path, answer.status, answer.body.error.code]).toEqual([
        method,
        path,
        403,
        "ONBOARDING_REQUIRED",
      ]);
    }
    // Nothing was written by any of them: no game, no link, no pair (A21-P-13).
    expect(counts()).toEqual(before);
    expect(
      h.query("SELECT 1 FROM past_opponents WHERE user_id = ? AND other_id = ?", ann.id, bob.id),
    ).toEqual([]);
    expect(seatOf(lobby.body.game.id, "state")).toBe("invited");

    // Her own account and games stay readable, and other players' games carry on with her in them.
    expect((await me(ann)).status).toBe(200);
    expect((await getGame(h, ann, finished)).game.status).toBe("finished");
    expect((await getGame(h, cy, lobby.body.game.id)).game.status).toBe("lobby");
    // What keeps existing games going stays open: turning her own link off, for one.
    expect(
      (await call(h, ann, "DELETE", `/api/v1/games/${own.body.game.id}/join-link`)).status,
    ).toBe(204);

    // Confirming again opens every gate.
    await patchMe(ann, { ageAttested: true });
    expect((await call(h, ann, "GET", "/api/v1/games")).status).toBe(200);
    expect(
      (await call(h, ann, "POST", `/api/v1/games/${finished}/add-player`, { userId: bob.id }))
        .status,
    ).toBe(204);
  });

  it("is still an onboarded account to other players: typing its address invites it", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const sam = await signUp(h, "Sam");
    forgetAge(sam);
    const game = await invite(ada, sam.email);
    expect(seatOf(game.id, "user_id")).toBe(sam.id);
  });
});

describe("POST /api/v1/me/under-age (06 §5)", () => {
  it("deletes a new account at once: sessions, challenges, the user; suppresses the address; email seats inert", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const kid = await signUp(h, null);
    const elsewhere = await otherDevice(kid);
    const game = await invite(ada, kid.email);
    const creatorBefore = await getGame(h, ada, game.id);
    const emailsBefore = (await invitesTo(kid.email)).length;
    const logsBefore = h.logs.length;

    const answer = await underAge(kid);
    expect(answer.status).toBe(204);
    expect(answer.headers.get("Set-Cookie")).toContain("Max-Age=0");
    for (const session of [kid, elsewhere]) expect((await me(session)).status).toBe(401);
    expect(h.query("SELECT 1 FROM users WHERE id = ?", kid.id)).toEqual([]);
    expect(h.query("SELECT 1 FROM sessions WHERE user_id = ?", kid.id)).toEqual([]);
    expect(h.query("SELECT 1 FROM otp_challenges WHERE email = ?", kid.email)).toEqual([]);
    expect(
      h.query(
        "SELECT reason FROM email_suppressions WHERE email_hash = ?",
        await emailIdOfAddress(kid.email),
      ),
    ).toEqual([{ reason: "unsubscribed" }]);
    // The seat is never delivered or claimed, and the creator sees it exactly as before (Q3).
    expect(seatOf(game.id, "delivery")).toBe("inert");
    expect(seatOf(game.id, "invite_email")).toBe(kid.email);
    expect(await getGame(h, ada, game.id)).toEqual(creatorBefore);
    // Logged as under_age_exit (and the deletion), pseudonymously, never with the address.
    const events = h.query(
      "SELECT type, user_id FROM auth_events WHERE type IN ('under_age_exit', 'account_deleted') ORDER BY type",
    );
    expect(events).toEqual([
      { type: "account_deleted", user_id: null },
      { type: "under_age_exit", user_id: null },
    ]);
    expect(JSON.stringify(h.logs.slice(logsBefore))).not.toContain(kid.email);

    // No more invite emails to the address; a later sign-up with it claims nothing.
    h.advance(DAY);
    await invite(ada, kid.email);
    await h.drain();
    expect((await invitesTo(kid.email)).length).toBe(emailsBefore);
    const again = await signUp(h, "Kim", kid.email);
    expect(again.id).not.toBe(kid.id);
    expect(seatOf(game.id, "user_id")).toBeNull();
    expect(seatOf(game.id, "delivery")).toBe("inert");
  });

  it("keeps an address's existing suppression reason", async () => {
    h = gameHarness();
    const kid = await signUp(h, null);
    const hash = await emailIdOfAddress(kid.email);
    h.exec(
      "INSERT INTO email_suppressions (email_hash, reason, created_at) VALUES (?, 'bounced', ?)",
      hash,
      now() - DAY,
    );
    expect((await underAge(kid)).status).toBe(204);
    expect(
      h.query("SELECT reason, created_at FROM email_suppressions WHERE email_hash = ?", hash),
    ).toEqual([{ reason: "bounced", created_at: now() - DAY }]);
  });

  it("a new account that set its name but not its age is still deleted", async () => {
    h = gameHarness();
    const kid = await signUp(h, null);
    await patchMe(kid, { displayName: "Kid" });
    expect((await underAge(kid)).status).toBe(204);
    expect(h.query("SELECT 1 FROM users WHERE id = ?", kid.id)).toEqual([]);
  });

  it("for a re-prompted account signs out this session only and deletes nothing (T5)", async () => {
    h = gameHarness();
    const parent = await signUp(h, "Pat");
    const other = await signUp(h, "Oli");
    const phone = await otherDevice(parent);
    const game = await invite(other, parent.email);
    forgetAge(parent);
    const before = userRow(parent.id);

    const answer = await underAge(phone);
    expect(answer.status).toBe(204);
    expect(answer.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await me(phone)).status).toBe(401);
    // The parent's other session, account, invitation and address are untouched.
    expect((await me(parent)).body).toMatchObject({ displayName: "Pat", needsOnboarding: true });
    expect(userRow(parent.id)).toEqual(before);
    expect(seatOf(game.id, "user_id")).toBe(parent.id);
    expect(seatOf(game.id, "delivery")).toBe("normal");
    expect(
      h.query(
        "SELECT 1 FROM email_suppressions WHERE email_hash = ?",
        await emailIdOfAddress(parent.email),
      ),
    ).toEqual([]);
    expect(h.query("SELECT user_id FROM auth_events WHERE type = 'under_age_exit'")).toEqual([
      { user_id: parent.id },
    ]);
    expect(h.query("SELECT 1 FROM auth_events WHERE type = 'account_deleted'")).toEqual([]);
  });

  it("answers 409 WRONG_STATUS once onboarding is done, and changes nothing", async () => {
    h = gameHarness();
    const sam = await signUp(h, "Sam");
    const answer = await call<ErrorBody>(h, sam, "POST", "/api/v1/me/under-age", {});
    expect(answer.status).toBe(409);
    expect(answer.body.error.code).toBe("WRONG_STATUS");
    expect((await me(sam)).status).toBe(200);
    expect(h.query("SELECT 1 FROM auth_events WHERE type = 'under_age_exit'")).toEqual([]);
  });

  it("needs a session, and takes no input", async () => {
    h = gameHarness();
    expect((await h.request("POST", "/api/v1/me/under-age", {})).status).toBe(401);
    const kid = await signUp(h, null);
    const extra = await h.request(
      "POST",
      "/api/v1/me/under-age",
      { confirm: true },
      { cookie: kid.cookie },
    );
    expect(extra.status).toBe(400);
    expect(h.query("SELECT 1 FROM users WHERE id = ?", kid.id)).toHaveLength(1);
  });

  it("with an empty body works too", async () => {
    h = gameHarness();
    const kid = await signUp(h, null);
    const answer = await h.request("POST", "/api/v1/me/under-age", undefined, {
      cookie: kid.cookie,
    });
    expect(answer.status).toBe(204);
  });
});

describe("round 1 review fixes (alpha A21)", () => {
  it("S-1: email nudges can't be turned on before onboarding, so a new account can't lift the exit's suppression", async () => {
    h = gameHarness();
    const kid = await signUp(h, null);
    expect((await underAge(kid)).status).toBe(204);
    const hash = await emailIdOfAddress(kid.email);
    // Signed in again: a new account with the same address, not onboarded.
    const again: Player = { ...kid, cookie: await h.signIn(kid.email) };
    const refused = await patchMe(again, { settings: { emailNudges: true } });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("ONBOARDING_REQUIRED");
    // With a name but no age it's still refused, and nothing of the request is written.
    const halfway = await patchMe(again, { displayName: "Kim", settings: { emailNudges: true } });
    expect(halfway.status).toBe(403);
    expect(h.query("SELECT display_name FROM users WHERE email = ?", kid.email)).toEqual([
      { display_name: null },
    ]);
    expect(h.query("SELECT reason FROM email_suppressions WHERE email_hash = ?", hash)).toEqual([
      { reason: "unsubscribed" },
    ]);
    // Turning them off is never refused.
    expect((await patchMe(again, { settings: { emailNudges: false } })).status).toBe(200);
    // The request that completes onboarding may turn them on: the holder's own opt-in (A20 P-3).
    const done = await patchMe(again, {
      displayName: "Kim",
      ageAttested: true,
      settings: { emailNudges: true },
    });
    expect(done.status).toBe(200);
    expect(done.body.needsOnboarding).toBe(false);
  });

  it("S-1: a re-prompted account can't turn email nudges on until it confirms again", async () => {
    h = gameHarness();
    const sam = await signUp(h, "Sam");
    forgetAge(sam);
    expect((await patchMe(sam, { settings: { emailNudges: true } })).status).toBe(403);
    expect(
      (await patchMe(sam, { ageAttested: true, settings: { emailNudges: true } })).status,
    ).toBe(200);
  });

  it("S-2 (A): a name and an age sent in parallel still complete onboarding, and claim once", async () => {
    h = gameHarness();
    const ada = await seasoned("Ada");
    const bo = await signUp(h, null);
    const game = await invite(ada, bo.email);
    const [named, aged] = await Promise.all([
      patchMe(bo, { displayName: "Bo" }),
      patchMe(bo, { ageAttested: true }),
    ]);
    expect([named.status, aged.status]).toEqual([200, 200]);
    expect(userRow(bo.id)).toMatchObject({ display_name: "Bo", age_attested_min_age: 13 });
    expect(userRow(bo.id)?.["onboarded_at"]).not.toBeNull();
    expect((await me(bo)).body.needsOnboarding).toBe(false);
    expect(seatOf(game.id, "user_id")).toBe(bo.id);
  });

  it("S-2 (B): a completing PATCH that loses to the under-age exit answers 401, claims nothing", async () => {
    let racer: Player | null = null;
    h = gameHarness(
      {},
      {
        wrapRepos: (repos) => ({
          ...repos,
          users: {
            ...repos.users,
            // The exit commits just before this request's answers are written.
            saveOnboarding: async (id, set, complete) => {
              if (racer !== null) {
                await h.request("POST", "/api/v1/me/under-age", {}, { cookie: racer.cookie });
              }
              return repos.users.saveOnboarding(id, set, complete);
            },
          },
        }),
      },
    );
    const ada = await seasoned("Ada");
    const kid = await signUp(h, null);
    const game = await invite(ada, kid.email);
    racer = await otherDevice(kid);
    const answer = await patchMe(kid, { displayName: "Kid", ageAttested: true });
    expect(answer.status).toBe(401);
    expect(answer.body.error.code).toBe("UNAUTHENTICATED");
    expect(h.query("SELECT 1 FROM users WHERE id = ?", kid.id)).toEqual([]);
    expect(seatOf(game.id, "user_id")).toBeNull();
    expect(seatOf(game.id, "delivery")).toBe("inert");
  });

  it("S-3: PATCH /me and the under-age exit count toward the per-user write limit", async () => {
    h = gameHarness({ LIMIT_WRITES_USER_MINUTE: "2" });
    const sam = await signUp(h, null);
    expect((await patchMe(sam, { displayName: "Sam" })).status).toBe(200);
    expect((await patchMe(sam, { settings: { theme: "dark" } })).status).toBe(200);
    const limited = await patchMe(sam, { ageAttested: true });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    const exit = await underAge(sam);
    expect(exit.status).toBe(429);
    expect(h.query("SELECT 1 FROM users WHERE id = ?", sam.id)).toHaveLength(1);
    h.advance(2 * MINUTE + 1);
    expect((await patchMe(sam, { ageAttested: true })).status).toBe(200);
  });

  it("P-4: an exit that loses to onboarding answers 409, keeps the session and logs nothing", async () => {
    h = gameHarness(
      {},
      {
        wrapRepos: (repos) => ({
          ...repos,
          users: {
            ...repos.users,
            // Onboarding commits just before the exit's batch.
            underAgeDelete: async (account, at) => {
              h.exec(
                "UPDATE users SET display_name = 'Kid', onboarded_at = ?, age_attested_at = ?, age_attested_min_age = 13 WHERE id = ?",
                at.createdAt,
                at.createdAt,
                account.id,
              );
              return repos.users.underAgeDelete(account, at);
            },
          },
        }),
      },
    );
    const kid = await signUp(h, null);
    const answer = await call<ErrorBody>(h, kid, "POST", "/api/v1/me/under-age", {});
    expect(answer.status).toBe(409);
    expect(answer.body.error.code).toBe("WRONG_STATUS");
    expect((await me(kid)).body).toMatchObject({ displayName: "Kid", needsOnboarding: false });
    expect(h.query("SELECT 1 FROM auth_events WHERE type = 'under_age_exit'")).toEqual([]);
    expect(h.query("SELECT 1 FROM email_suppressions")).toEqual([]);
  });
});
