/**
 * Join links (alpha A18; docs/spec/06-auth.md §6.8, 05 §Join links and `…/join-link`, 02 §4, 08
 * T24 and §4): creating, rotating and revoking a link, its token (hashed at rest, only in the URL's
 * fragment, never in a log line), the lookup and the join with their one indistinguishable `404`,
 * no re-entry after a decline or a removal while the link was live, blocks with anyone holding a
 * row, the rule that a game with a live link or a link joiner waits for its creator's Start, the
 * creator's remove, the joiner's limits, and Q3: what the link shows and how it refuses never
 * depend on whether a typed address has an account. The real app on a real SQLite database.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
import { DAY, HOUR, type Harness } from "./test-harness.js";

let h: Harness;
beforeEach(() => {
  h = gameHarness();
});
afterEach(() => {
  h.close();
});

const now = (): number => h.platform.now().getTime();
const code = (body: unknown): string | undefined => (body as Partial<ErrorBody>).error?.code;

interface Preview {
  readonly game: {
    readonly id: string;
    readonly creatorName: string | null;
    readonly players: readonly { displayName: string | null; kind: string }[];
    readonly openSeats: number;
    readonly expiresAt: number;
  } & Record<string, unknown>;
}

interface Envelope {
  readonly game: {
    readonly id: string;
    readonly status: string;
    readonly version: number;
    readonly joinLink?: { active: boolean; expiresAt: number | null };
    readonly players: readonly {
      playerId?: string;
      userId: string | null;
      displayName: string | null;
      state: string;
      invitedAs?: string;
      isYou: boolean;
    }[];
  };
}

/** The token in a link's fragment. */
function tokenOf(url: string): string {
  const match = /^https:\/\/play\.example\.org\/join#([A-Za-z0-9_-]{22})$/u.exec(url);
  if (match?.[1] === undefined) throw new Error(`not a join link: ${url}`);
  return match[1];
}

/** A lobby of `seats` with any invitees, and a link asked for at creation; its token. */
async function linkedLobby(
  creator: Player,
  options: { seats?: number; invitees?: readonly Record<string, string>[] } = {},
) {
  const created = await call<{ game: Envelope["game"]; joinLinkUrl?: string }>(
    h,
    creator,
    "POST",
    "/api/v1/games",
    {
      gameType: "example",
      seats: options.seats ?? 2,
      invitees: options.invitees ?? [],
      joinLink: true,
    },
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return {
    gameId: created.body.game.id,
    game: created.body.game,
    token: tokenOf(created.body.joinLinkUrl ?? ""),
  };
}

const makeLink = (player: Player, gameId: string) =>
  call<{ url: string; expiresAt: number } & ErrorBody>(
    h,
    player,
    "POST",
    `/api/v1/games/${gameId}/join-link`,
    {},
  );
const revoke = (player: Player, gameId: string) =>
  call<ErrorBody>(h, player, "DELETE", `/api/v1/games/${gameId}/join-link`);
const lookup = (player: Player, token: string) =>
  call<Preview & ErrorBody>(h, player, "POST", "/api/v1/join/lookup", { token });
const join = (player: Player, token: string) =>
  call<Envelope & ErrorBody>(h, player, "POST", "/api/v1/join", { token });
const removeSeat = async (creator: Player, gameId: string, playerId: string) => {
  const { game } = await getGame(h, creator, gameId);
  return call<Envelope & ErrorBody>(h, creator, "POST", `/api/v1/games/${gameId}/remove-seat`, {
    expectedVersion: game.version,
    playerId,
  });
};

/** `blocker` blocks `blocked` (04 `blocks`; nothing writes one through the API before M4). */
function block(blocker: Player, blocked: Player): void {
  h.exec(
    "INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)",
    blocker.id,
    blocked.id,
    now(),
  );
}

const rowOf = (gameId: string, userId: string) =>
  h.query(
    "SELECT id, state, joined_via, removed_at, invite_email FROM game_players WHERE game_id = ? AND user_id = ?",
    gameId,
    userId,
  )[0];

/** The lobby row of `userId` as the creator's envelope lists it (for its `playerId`). */
async function playerIdOf(creator: Player, gameId: string, userId: string): Promise<string> {
  const row = h.query(
    "SELECT id FROM game_players WHERE game_id = ? AND user_id = ?",
    gameId,
    userId,
  )[0];
  const { game } = await getGame(h, creator, gameId);
  const listed = game.players.find((player) => player.playerId === row?.["id"]);
  if (listed?.playerId === undefined) throw new Error("no such lobby row");
  return listed.playerId;
}

/** The `404` every refusal gives: one body, whatever the reason (06 §6.8). */
const NOT_FOUND = { error: { code: "NOT_FOUND", message: "Not found." } };

describe("creating, rotating and revoking a link (05, 06 §6.8)", () => {
  it("returns the URL once, at creation, with the token only in its fragment", async () => {
    const a = await signUp(h, "Ada");
    const { gameId, game, token } = await linkedLobby(a);
    expect(game.status).toBe("lobby");
    expect(game.joinLink).toEqual({ active: true, expiresAt: now() + 7 * DAY });
    // Afterwards the creator sees that it works and until when, never the link again.
    const read = await getGame(h, a, gameId);
    expect(read.game.joinLink).toEqual({ active: true, expiresAt: now() + 7 * DAY });
    expect(JSON.stringify(read)).not.toContain(token);
  });

  it("is stored only as the token's SHA-256", async () => {
    const a = await signUp(h, "Ada");
    const { gameId, token } = await linkedLobby(a);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    );
    const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(h.query("SELECT token_hash FROM join_links WHERE game_id = ?", gameId)).toEqual([
      { token_hash: hex },
    ]);
    const everything = JSON.stringify(
      ["join_links", "games", "game_players", "rate_limits"].map((table) =>
        h.query(`SELECT * FROM ${table}`),
      ),
    );
    expect(everything).not.toContain(token);
  });

  it("is shown only to the creator", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const { gameId, token } = await linkedLobby(a, { seats: 3 });
    expect((await join(b, token)).status).toBe(200);
    expect((await getGame(h, b, gameId)).game).not.toHaveProperty("joinLink");
  });

  it("rotates: a new token, the old one dead, the game's version unchanged", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const { gameId, token } = await linkedLobby(a);
    const version = (await getGame(h, a, gameId)).game.version;
    h.advance(HOUR);
    const rotated = await makeLink(a, gameId);
    expect(rotated.status).toBe(200);
    expect(rotated.body.expiresAt).toBe(now() + 7 * DAY);
    const fresh = tokenOf(rotated.body.url);
    expect(fresh).not.toBe(token);
    expect(await lookup(b, token)).toEqual({ status: 404, body: NOT_FOUND });
    expect((await lookup(b, fresh)).status).toBe(200);
    expect((await getGame(h, a, gameId)).game.version).toBe(version);
  });

  it("can be made in a lobby that had none, and revoked, which ends nothing", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const created = await createGame(h, a, { gameType: "example", invitees: [] });
    expect(created.joinLink).toEqual({ active: false, expiresAt: null });
    const made = await makeLink(a, created.id);
    const token = tokenOf(made.body.url);
    expect((await lookup(b, token)).status).toBe(200);
    expect((await revoke(a, created.id)).status).toBe(204);
    expect(await lookup(b, token)).toEqual({ status: 404, body: NOT_FOUND });
    const after = await getGame(h, a, created.id);
    expect([after.game.status, after.game.joinLink]).toEqual([
      "lobby",
      { active: false, expiresAt: null },
    ]);
    // Revoking again, or with no link, is still 204.
    expect((await revoke(a, created.id)).status).toBe(204);
  });

  it("is the creator's alone: another member is 403, anyone else 404", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const c = await signUp(h, "Cy");
    const { gameId, token } = await linkedLobby(a, { seats: 3 });
    await join(b, token);
    for (const [who, status, expected] of [
      [b, 403, "NOT_ALLOWED"],
      [c, 404, "NOT_FOUND"],
    ] as const) {
      const made = await makeLink(who, gameId);
      expect([made.status, code(made.body)]).toEqual([status, expected]);
      const revoked = await revoke(who, gameId);
      expect([revoked.status, code(revoked.body)]).toEqual([status, expected]);
    }
    expect((await lookup(c, token)).status).toBe(200);
  });

  it("can't be made once the lobby has ended; revoking then is still 204", async () => {
    const a = await signUp(h, "Ada");
    const created = await createGame(h, a, { gameType: "example", invitees: [] });
    expect((await transition(h, a, created.id, "cancel")).status).toBe(200);
    const made = await makeLink(a, created.id);
    expect([made.status, code(made.body)]).toEqual([409, "WRONG_STATUS"]);
    expect((await revoke(a, created.id)).status).toBe(204);
  });

  it("works 7 days at most, never past the lobby's expiry; the lobby outlives its link", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const { gameId, token } = await linkedLobby(a);
    h.advance(7 * DAY - 1);
    expect((await lookup(b, token)).status).toBe(200);
    h.advance(1);
    expect(await lookup(b, token)).toEqual({ status: 404, body: NOT_FOUND });
    const read = await getGame(h, a, gameId);
    expect([read.game.status, read.game.joinLink]).toEqual([
      "lobby",
      { active: false, expiresAt: null },
    ]);
    // Made on day 10 of 14, a link ends with the lobby.
    h.advance(3 * DAY);
    const late = await makeLink(a, gameId);
    expect(late.body.expiresAt).toBe(now() - 10 * DAY + 14 * DAY);
  });

  it("is deleted by the sweep once expired", async () => {
    const a = await signUp(h, "Ada");
    const { gameId } = await linkedLobby(a);
    h.advance(7 * DAY);
    const report = await h.sweep();
    expect(report.joinLinks).toBe(1);
    expect(h.query("SELECT * FROM join_links WHERE game_id = ?", gameId)).toEqual([]);
  });

  it("counts toward the creator's 20 a day, at creation as in the lobby", async () => {
    const a = await signUp(h, "Ada");
    const { gameId } = await linkedLobby(a);
    for (let i = 1; i < 20; i++) expect((await makeLink(a, gameId)).status).toBe(200);
    const over = await makeLink(a, gameId);
    expect([over.status, code(over.body)]).toEqual([429, "RATE_LIMITED"]);
    const games = h.query("SELECT count(*) AS n FROM games")[0]?.["n"];
    const create = await call(h, a, "POST", "/api/v1/games", {
      gameType: "example",
      invitees: [],
      joinLink: true,
    });
    expect([create.status, code(create.body)]).toEqual([429, "RATE_LIMITED"]);
    expect(h.query("SELECT count(*) AS n FROM games")[0]?.["n"]).toBe(games);
    h.advance(2 * DAY);
    expect((await makeLink(a, gameId)).status).toBe(200);
  });
});

describe("the lookup and the join (05 §Join links)", () => {
  it("shows the game, its creator and joined players only, and joins on request", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const c = await signUp(h, "Cy");
    const { gameId, token } = await linkedLobby(a, {
      seats: 4,
      invitees: [{ email: "someone@example.org" }],
    });
    const seen = await lookup(b, token);
    expect(seen.status).toBe(200);
    expect(seen.body.game).toEqual({
      id: gameId,
      gameType: "example",
      options: expect.anything() as unknown,
      resources: [],
      turnTimeoutDays: expect.any(Number) as unknown,
      seatOrder: "join",
      aiAssistance: "off",
      creatorName: "Ada",
      players: [{ displayName: "Ada", kind: "human" }],
      openSeats: 2,
      expiresAt: now() + 7 * DAY,
    });
    expect(JSON.stringify(seen.body)).not.toContain("someone@example.org");
    // Looking joins nothing.
    expect(rowOf(gameId, b.id)).toBeUndefined();

    const joined = await join(b, token);
    expect(joined.status).toBe(200);
    expect(joined.body.game.players.find((p) => p.isYou)?.state).toBe("joined");
    expect(rowOf(gameId, b.id)).toMatchObject({ state: "joined", joined_via: "join_link" });
    expect((await lookup(c, token)).body.game.players).toEqual([
      { displayName: "Ada", kind: "human" },
      { displayName: "Bo", kind: "human" },
    ]);
    // The creator sees who joined.
    const creatorView = await getGame(h, a, gameId);
    expect(creatorView.game.players.map((p) => p.displayName)).toEqual(["Ada", null, "Bo"]);
  });

  it("answers a second join, or the creator's own, with ALREADY_JOINED; their lookup still shows it", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const { token } = await linkedLobby(a, { seats: 3 });
    await join(b, token);
    for (const who of [a, b]) {
      expect((await lookup(who, token)).status).toBe(200);
      const again = await join(who, token);
      expect([again.status, code(again.body)]).toEqual([409, "ALREADY_JOINED"]);
    }
  });

  it("is the same 404 once the game is full, has started or was cancelled", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const c = await signUp(h, "Cy");
    const { gameId, token } = await linkedLobby(a);
    await join(b, token);
    expect(await lookup(c, token)).toEqual({ status: 404, body: NOT_FOUND });
    expect(await join(c, token)).toEqual({ status: 404, body: NOT_FOUND });
    expect((await transition(h, a, gameId, "start")).status).toBe(200);
    // The start deleted the link.
    expect(h.query("SELECT * FROM join_links WHERE game_id = ?", gameId)).toEqual([]);
    expect(await lookup(b, token)).toEqual({ status: 404, body: NOT_FOUND });
  });

  it("refuses any value but a live link's token with the same 404, and an over-long one as a bad request", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    await linkedLobby(a);
    for (const token of ["", "nope", "A".repeat(22), "A".repeat(64), "../../etc/passwd"]) {
      expect(await lookup(b, token)).toEqual({ status: 404, body: NOT_FOUND });
      expect(await join(b, token)).toEqual({ status: 404, body: NOT_FOUND });
    }
    expect((await lookup(b, "A".repeat(65))).status).toBe(400);
  });

  it("needs a signed-in, onboarded user", async () => {
    const a = await signUp(h, "Ada");
    const { token } = await linkedLobby(a);
    const newcomer = await signUp(h, null);
    for (const path of ["/api/v1/join/lookup", "/api/v1/join"]) {
      const answer = await call(h, newcomer, "POST", path, { token });
      expect([answer.status, code(answer.body)]).toEqual([403, "ONBOARDING_REQUIRED"]);
      const anonymous = await h.request("POST", path, { token });
      expect(anonymous.status).toBe(401);
    }
  });

  it("accepts the invitation the joiner already holds, even with no seat open", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const { gameId, token } = await linkedLobby(a, { invitees: [{ email: b.email }] });
    expect((await lookup(b, token)).body.game.openSeats).toBe(0);
    const joined = await join(b, token);
    expect(joined.status).toBe(200);
    expect(rowOf(gameId, b.id)).toMatchObject({
      state: "joined",
      joined_via: "invitation",
      invite_email: null,
    });
    expect(h.query("SELECT count(*) AS n FROM game_players WHERE game_id = ?", gameId)).toEqual([
      { n: 2 },
    ]);
  });

  it("never accepts an inert invitation: its holder gets the 404", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const { gameId, token } = await linkedLobby(a, { seats: 3, invitees: [{ email: b.email }] });
    h.exec(
      "UPDATE game_players SET delivery = 'inert' WHERE game_id = ? AND user_id = ?",
      gameId,
      b.id,
    );
    expect(await lookup(b, token)).toEqual({ status: 404, body: NOT_FOUND });
    expect(await join(b, token)).toEqual({ status: 404, body: NOT_FOUND });
    expect(rowOf(gameId, b.id)).toMatchObject({ state: "invited" });
  });
});

describe("no re-entry (06 §6.8)", () => {
  it("after a decline", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const { gameId, token } = await linkedLobby(a, { seats: 3 });
    await join(b, token);
    expect((await transition(h, b, gameId, "decline")).status).toBe(204);
    expect(await lookup(b, token)).toEqual({ status: 404, body: NOT_FOUND });
    expect(await join(b, token)).toEqual({ status: 404, body: NOT_FOUND });
    // Not even through a new link.
    const fresh = tokenOf((await makeLink(a, gameId)).body.url);
    expect(await join(b, fresh)).toEqual({ status: 404, body: NOT_FOUND });
  });

  it("after a removal while the link was live, until a rotation re-admits them", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const { gameId, token } = await linkedLobby(a, { seats: 3 });
    await join(b, token);
    const rowId = rowOf(gameId, b.id)?.["id"];
    expect((await removeSeat(a, gameId, await playerIdOf(a, gameId, b.id))).status).toBe(200);
    expect(rowOf(gameId, b.id)).toMatchObject({ state: "removed", removed_at: now() });
    expect(await lookup(b, token)).toEqual({ status: 404, body: NOT_FOUND });
    expect(await join(b, token)).toEqual({ status: 404, body: NOT_FOUND });
    h.advance(1);
    const fresh = tokenOf((await makeLink(a, gameId)).body.url);
    expect((await join(b, fresh)).status).toBe(200);
    expect(rowOf(gameId, b.id)).toMatchObject({
      id: rowId,
      state: "joined",
      joined_via: "join_link",
      removed_at: null,
    });
  });

  it("lets in someone removed before the link was made", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const created = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }],
    });
    const playerId = (await getGame(h, a, created.id)).game.players.find(
      (p) => p.invitedAs === b.email,
    )?.playerId;
    expect((await removeSeat(a, created.id, playerId ?? "")).status).toBe(200);
    h.advance(1);
    const token = tokenOf((await makeLink(a, created.id)).body.url);
    expect((await join(b, token)).status).toBe(200);
    expect(rowOf(created.id, b.id)).toMatchObject({ state: "joined", joined_via: "join_link" });
  });
});

describe("blocks with anyone holding a row (06 §6.8, §6.10)", () => {
  it.each([
    ["the joiner blocked the creator", "joiner", "creator"],
    ["the creator blocked the joiner", "creator", "joiner"],
    ["a joined member blocked the joiner", "member", "joiner"],
    ["the joiner blocked an invited player", "joiner", "invited"],
    ["someone who declined blocked the joiner", "declined", "joiner"],
  ] as const)("refuses with the same 404 when %s", async (_name, blocker, blocked) => {
    const people = {
      creator: await signUp(h, "Ada"),
      member: await signUp(h, "Bo"),
      invited: await signUp(h, "Cy"),
      declined: await signUp(h, "Di"),
      joiner: await signUp(h, "Ed"),
    };
    const { gameId, token } = await linkedLobby(people.creator, {
      seats: 4,
      invitees: [{ email: people.invited.email }, { email: people.declined.email }],
    });
    await join(people.member, token);
    await transition(h, people.declined, gameId, "decline");
    expect((await lookup(people.joiner, token)).status).toBe(200);
    block(people[blocker], people[blocked]);
    expect(await lookup(people.joiner, token)).toEqual({ status: 404, body: NOT_FOUND });
    expect(await join(people.joiner, token)).toEqual({ status: 404, body: NOT_FOUND });
    expect(rowOf(gameId, people.joiner.id)).toBeUndefined();
  });

  it("ignores blocks between other people", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const stranger = await signUp(h, "Cy");
    const { token } = await linkedLobby(a, { seats: 3 });
    block(stranger, a);
    expect((await join(b, token)).status).toBe(200);
  });
});

describe("the creator's Start (02 §4, 08 T24)", () => {
  it("a game with a live link doesn't start when its last invitee accepts", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const { gameId, token } = await linkedLobby(a, { invitees: [{ email: b.email }] });
    const accepted = await transition(h, b, gameId, "accept");
    expect(accepted.body.game.status).toBe("lobby");
    expect((await transition(h, a, gameId, "start")).body.game.status).toBe("active");
    expect(await lookup(b, token)).toEqual({ status: 404, body: NOT_FOUND });
  });

  it("a link joiner holds the start for the creator, even after the link is revoked", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const c = await signUp(h, "Cy");
    const { gameId, token } = await linkedLobby(a, { seats: 3, invitees: [{ email: c.email }] });
    await join(b, token);
    expect((await revoke(a, gameId)).status).toBe(204);
    expect((await transition(h, c, gameId, "accept")).body.game.status).toBe("lobby");
    expect((await getGame(h, a, gameId)).game.status).toBe("lobby");
    const started = await transition(h, a, gameId, "start");
    expect(started.body.game.status).toBe("active");
  });

  it("a game created full of past opponents doesn't start at creation with a link asked for", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    h.exec(
      "INSERT INTO past_opponents (user_id, other_id, last_finished_at) VALUES (?, ?, ?), (?, ?, ?)",
      a.id,
      b.id,
      now(),
      b.id,
      a.id,
      now(),
    );
    const created = await call<{ game: Envelope["game"]; joinLinkUrl?: string }>(
      h,
      a,
      "POST",
      "/api/v1/games",
      { gameType: "example", invitees: [{ userId: b.id }], joinLink: true },
    );
    expect(created.status).toBe(201);
    expect(created.body.game.status).toBe("lobby");
    expect(created.body.joinLinkUrl).toBeDefined();
  });

  it("a lobby decline doesn't end the lobby while its link is live", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const c = await signUp(h, "Cy");
    const { gameId, token } = await linkedLobby(a);
    await join(b, token);
    expect((await transition(h, b, gameId, "decline")).status).toBe(204);
    expect((await getGame(h, a, gameId)).game.status).toBe("lobby");
    expect((await join(c, token)).status).toBe(200);
  });

  it("link joiners never become past opponents automatically; an invitation accepted by link does", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const c = await signUp(h, "Cy");
    const { gameId, token } = await linkedLobby(a, { seats: 3, invitees: [{ email: c.email }] });
    await join(b, token);
    await join(c, token);
    await transition(h, a, gameId, "start");
    await playExampleToEnd(h, gameId, [a, b, c]);
    expect((await getGame(h, a, gameId)).game.status).toBe("finished");
    const pairs = h
      .query("SELECT user_id, other_id FROM past_opponents")
      .map((row) => `${String(row["user_id"])}>${String(row["other_id"])}`)
      .sort();
    expect(pairs).toEqual([`${a.id}>${c.id}`, `${c.id}>${a.id}`].sort());
  });
});

describe("remove seat (05 POST /remove-seat)", () => {
  it("removes a joined or invited row, clearing a typed address, and never ends the lobby", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const { gameId, token } = await linkedLobby(a, {
      seats: 3,
      invitees: [{ email: "nobody-yet@example.org" }],
    });
    await join(b, token);
    const before = (await getGame(h, a, gameId)).game;
    const typed = before.players.find((p) => p.invitedAs === "nobody-yet@example.org");
    const removed = await removeSeat(a, gameId, typed?.playerId ?? "");
    expect(removed.status).toBe(200);
    const shown = removed.body.game.players.find((p) => p.playerId === typed?.playerId);
    expect(shown).toMatchObject({ state: "removed", userId: null, displayName: null });
    expect(shown).not.toHaveProperty("invitedAs");
    expect(
      h.query("SELECT invite_email FROM game_players WHERE id = ?", typed?.playerId ?? ""),
    ).toEqual([{ invite_email: null }]);
    expect((await removeSeat(a, gameId, await playerIdOf(a, gameId, b.id))).status).toBe(200);
    expect((await getGame(h, a, gameId)).game.status).toBe("lobby");
    // The removed joiner is no longer a member.
    expect((await call(h, b, "GET", `/api/v1/games/${gameId}`)).status).toBe(404);
  });

  it("is the creator's alone, for another row of this game", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const { gameId, token } = await linkedLobby(a, { seats: 3 });
    const other = await linkedLobby(a, { seats: 3 });
    await join(b, token);
    const own = h.query(
      "SELECT id FROM game_players WHERE game_id = ? AND user_id = ?",
      gameId,
      a.id,
    )[0]?.["id"] as string;
    const elsewhere = h.query(
      "SELECT id FROM game_players WHERE game_id = ? AND user_id = ?",
      other.gameId,
      a.id,
    )[0]?.["id"] as string;
    for (const playerId of [own, elsewhere, "no-such-row"]) {
      const answer = await removeSeat(a, gameId, playerId);
      expect([answer.status, code(answer.body)]).toEqual([404, "NOT_FOUND"]);
    }
    const byOther = await removeSeat(b, gameId, own);
    expect([byOther.status, code(byOther.body)]).toEqual([403, "NOT_ALLOWED"]);
    const stale = await call(h, a, "POST", `/api/v1/games/${gameId}/remove-seat`, {
      expectedVersion: 0,
      playerId: await playerIdOf(a, gameId, b.id),
    });
    expect([stale.status, code(stale.body)]).toEqual([409, "STALE_GAME"]);
  });
});

describe("the joiner's limits (08 §4)", () => {
  it("30 lookups and joins an hour per user, whatever they answer", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const { token } = await linkedLobby(a, { seats: 3 });
    for (let i = 0; i < 29; i++) expect((await lookup(b, "A".repeat(22))).status).toBe(404);
    expect((await join(b, token)).status).toBe(200);
    const over = await lookup(b, token);
    expect([over.status, code(over.body)]).toEqual([429, "RATE_LIMITED"]);
    // The creator's own allowance is untouched.
    expect((await lookup(a, token)).status).toBe(200);
    h.advance(2 * HOUR);
    expect((await lookup(b, token)).status).toBe(200);
  });

  it("60 an hour per IP bucket, across users", async () => {
    const a = await signUp(h, "Ada");
    const [b, c, d] = [await signUp(h, "Bo"), await signUp(h, "Cy"), await signUp(h, "Di")];
    const people = [b, c, d];
    const { token } = await linkedLobby(a, { seats: 3 });
    const from = (player: Player, ip: string) =>
      h.request("POST", "/api/v1/join/lookup", { token }, { cookie: player.cookie, ip });
    for (let i = 0; i < 60; i++) {
      expect((await from(people[i % 3] ?? b, "198.51.100.7")).status).toBe(200);
    }
    expect((await from(b, "198.51.100.7")).status).toBe(429);
    expect((await from(b, "198.51.100.8")).status).toBe(200);
  });

  it("needs the client's address, like every route with an IP limit", async () => {
    const a = await signUp(h, "Ada");
    const { token } = await linkedLobby(a);
    const b = await signUp(h, "Bo");
    const answer = await h.request(
      "POST",
      "/api/v1/join/lookup",
      { token },
      { cookie: b.cookie, ip: null },
    );
    expect(answer.status).toBe(400);
  });
});

describe("Q3 parity (06 §6.1, §6.8)", () => {
  it("the link shows the same whatever a typed address turns out to be", async () => {
    const shown: unknown[] = [];
    for (const kind of ["onboarded", "unknown", "un-onboarded"] as const) {
      const a = await signUp(h, "Ada");
      const viewer = await signUp(h, "Vi");
      let email = freshEmail();
      if (kind === "onboarded") email = (await signUp(h, "Bo")).email;
      if (kind === "un-onboarded") email = (await signUp(h, null)).email;
      const { token } = await linkedLobby(a, { seats: 3, invitees: [{ email }] });
      const seen = await lookup(viewer, token);
      expect(seen.status).toBe(200);
      // Everything but what differs between any two games: the id and the expiry time.
      shown.push({ ...seen.body.game, id: null, expiresAt: null });
      h.advance(HOUR);
    }
    expect(shown[1]).toEqual(shown[0]);
    expect(shown[2]).toEqual(shown[0]);
  });

  it("every refusal is the same body: unknown, revoked, expired, full, blocked, declined, removed, inert", async () => {
    const answers: unknown[] = [];
    const record = async (who: Player, token: string) => {
      answers.push(await lookup(who, token), await join(who, token));
    };
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const c = await signUp(h, "Cy");
    await record(b, "A".repeat(22));
    const revoked = await linkedLobby(a, { seats: 3 });
    await revoke(a, revoked.gameId);
    await record(b, revoked.token);
    const full = await linkedLobby(a);
    await join(c, full.token);
    await record(b, full.token);
    const blocked = await linkedLobby(a, { seats: 3 });
    block(a, b);
    await record(b, blocked.token);
    h.exec("DELETE FROM blocks");
    const declined = await linkedLobby(a, { seats: 3 });
    await join(b, declined.token);
    await transition(h, b, declined.gameId, "decline");
    await record(b, declined.token);
    const removed = await linkedLobby(a, { seats: 3 });
    await join(b, removed.token);
    await removeSeat(a, removed.gameId, await playerIdOf(a, removed.gameId, b.id));
    await record(b, removed.token);
    const inert = await linkedLobby(a, { seats: 3, invitees: [{ email: b.email }] });
    h.exec(
      "UPDATE game_players SET delivery = 'inert' WHERE user_id = ? AND game_id = ?",
      b.id,
      inert.gameId,
    );
    await record(b, inert.token);
    const expired = await linkedLobby(a, { seats: 3 });
    h.advance(7 * DAY);
    await record(b, expired.token);
    expect(answers).toHaveLength(16);
    for (const answer of answers) expect(answer).toEqual({ status: 404, body: NOT_FOUND });
  });
});

describe("tokens never reach a log line (08 T24, T15)", () => {
  it("through creating, rotating, looking up, joining and every refusal", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const c = await signUp(h, "Cy");
    const tokens: string[] = [];
    const { gameId, token } = await linkedLobby(a);
    tokens.push(token);
    const rotated = tokenOf((await makeLink(a, gameId)).body.url);
    tokens.push(rotated);
    await lookup(b, token);
    await lookup(b, rotated);
    await join(b, rotated);
    await join(c, rotated);
    await lookup(c, `${rotated}x`);
    await call(h, c, "POST", "/api/v1/join", { token: rotated, extra: true });
    await call(h, c, "POST", "/api/v1/join", { token: `${rotated}${"y".repeat(60)}` });
    await revoke(a, gameId);
    await lookup(b, rotated);
    await h.drain();
    const logged = JSON.stringify(h.logs);
    expect(h.logs.length).toBeGreaterThan(10);
    for (const secret of tokens) expect(logged).not.toContain(secret);
    // The request lines name the route, never a path with anything in it.
    const routes = h.logs.filter((line) => line["msg"] === "request").map((line) => line["route"]);
    expect(routes).toContain("/api/v1/join");
    expect(routes).toContain("/api/v1/join/lookup");
  });
});
