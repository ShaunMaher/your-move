/**
 * Blocking (alpha A23; docs/spec/05-api.md §Blocks, 06 §6.10, 02 §4, 04 invariant 6, Q29): the
 * endpoints and their refusals, what a new block changes in shared lobbies and what it must leave
 * alone (Q3), the accept and start checks, active games carrying on, and a rematch's inert
 * invitation. The real app on a real SQLite database with the installed games.
 */
import type { Repositories } from "@your-move/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  call,
  createGame,
  type ErrorBody,
  gameHarness,
  getGame,
  playExampleToEnd,
  type Player,
  signUp,
  transition,
} from "./games-support.js";
import { DAY, type Harness } from "./test-harness.js";

/**
 * Injected faults (A23-P-7, S-4): the next `missBlocks` reads of a lobby's blocks find none, as a
 * read made just before a block landed would; the next `loseRaces` transitions lose their race.
 */
const faults = { missBlocks: 0, loseRaces: 0 };
const faulty = (repos: Repositories): Repositories => ({
  ...repos,
  users: {
    ...repos.users,
    blocksAmong: (ids) => {
      if (faults.missBlocks === 0) return repos.users.blocksAmong(ids);
      faults.missBlocks -= 1;
      return Promise.resolve([]);
    },
  },
  games: {
    ...repos.games,
    applyTransition: (...args) => {
      if (faults.loseRaces === 0) return repos.games.applyTransition(...args);
      faults.loseRaces -= 1;
      return Promise.resolve("stale");
    },
  },
});

let h: Harness;
beforeEach(() => {
  faults.missBlocks = 0;
  faults.loseRaces = 0;
  h = gameHarness({}, { wrapRepos: faulty });
});
afterEach(() => {
  h.close();
});

const now = (): number => h.platform.now().getTime();

const code = (body: unknown): string | undefined => (body as Partial<ErrorBody>).error?.code;

interface BlockList {
  readonly blocks: readonly { userId: string; displayName: string | null; createdAt: number }[];
  readonly nextCursor: string | null;
}

const block = (viewer: Player, other: Player | string) =>
  call(h, viewer, "POST", "/api/v1/blocks", {
    userId: typeof other === "string" ? other : other.id,
  });
const unblock = (viewer: Player, other: Player | string) =>
  call(h, viewer, "DELETE", `/api/v1/blocks/${typeof other === "string" ? other : other.id}`);
const listBlocks = (viewer: Player, cursor?: string) =>
  call<BlockList>(
    h,
    viewer,
    "GET",
    `/api/v1/blocks${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
  );

/** Records `a` and `b` as past opponents, as a finished game would (04 `past_opponents`). */
function pastOpponents(a: Player, b: Player): void {
  h.exec(
    "INSERT INTO past_opponents (user_id, other_id, last_finished_at) VALUES (?, ?, ?), (?, ?, ?)",
    a.id,
    b.id,
    now(),
    b.id,
    a.id,
    now(),
  );
}

const pairs = () => h.query("SELECT user_id, other_id FROM past_opponents ORDER BY user_id");

const rowsOf = (gameId: string) =>
  h.query(
    "SELECT user_id, state, delivery, invite_email, removed_at IS NOT NULL AS removed FROM game_players WHERE game_id = ? ORDER BY rowid",
    gameId,
  );

const versionOf = (gameId: string): unknown =>
  h.query("SELECT version FROM games WHERE id = ?", gameId)[0]?.["version"];

const statusOf = (gameId: string): unknown =>
  h.query("SELECT status FROM games WHERE id = ?", gameId)[0]?.["status"];

/** A lobby `creator` made, with `joiners` invited by address and accepted, `seats` in all. */
async function lobbyWith(creator: Player, joiners: readonly Player[], seats: number) {
  const game = await createGame(h, creator, {
    gameType: "example",
    seats,
    invitees: joiners.map((player) => ({ email: player.email })),
  });
  for (const joiner of joiners) {
    expect((await transition(h, joiner, game.id, "accept")).status).toBe(200);
  }
  return game.id;
}

describe("POST /api/v1/blocks: who can be blocked (05 §Blocks)", () => {
  it("blocks a past opponent: 204, listed, and repeating it is the same 204", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    pastOpponents(a, b);
    expect((await block(a, b)).status).toBe(204);
    const at = now();
    h.advance(1000);
    expect((await block(a, b)).status).toBe(204);
    // A repeat keeps the first block's time.
    expect((await listBlocks(a)).body).toEqual({
      blocks: [{ userId: b.id, displayName: "Bo", createdAt: at }],
      nextCursor: null,
    });
    // Only the blocker's list shows it.
    expect((await listBlocks(b)).body).toEqual({ blocks: [], nextCursor: null });
  });

  it("blocks someone whose row you can attribute, in any state of the game", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    // b declined a's invitation: b can still block a, who created (and so joined) the game.
    const declined = await createGame(h, a, { gameType: "words", invitees: [{ email: b.email }] });
    expect((await transition(h, b, declined.id, "decline")).status).toBe(204);
    expect((await block(b, a)).status).toBe(204);
    // c holds an open invitation from a: c can block a.
    await createGame(h, a, { gameType: "words", invitees: [{ email: c.email }] });
    expect((await block(c, a)).status).toBe(204);
  });

  it("never through a typed address: a probe by id gets the stranger's 404 (A23-S-1, Q3)", async () => {
    const [x, prober] = [await signUp(h, "Xan"), await signUp(h, "Pro")];
    // The prober types x's address, open, then declined by x: neither ties it to x's account.
    const game = await createGame(h, prober, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: x.email }],
    });
    const before = rowsOf(game.id);
    const open = await block(prober, x);
    expect([open.status, code(open.body)]).toEqual([404, "NOT_FOUND"]);
    expect(rowsOf(game.id)).toEqual(before);
    expect((await transition(h, x, game.id, "decline")).status).toBe(204);
    const after = await block(prober, x);
    expect([after.status, code(after.body)]).toEqual([404, "NOT_FOUND"]);
    expect(h.query("SELECT count(*) AS n FROM blocks")[0]?.["n"]).toBe(0);
  });

  it("is 404 for a stranger, yourself, an unknown id and an AI account, writing nothing", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const agent = crypto.randomUUID();
    h.exec(
      "INSERT INTO users (id, kind, owner_user_id, display_name, created_at, updated_at) VALUES (?, 'agent', ?, 'Bot', ?, ?)",
      agent,
      b.id,
      now(),
      now(),
    );
    pastOpponents(a, b);
    for (const target of [await signUp(h, "Cy"), a, crypto.randomUUID(), agent]) {
      const answer = await block(a, target);
      expect([answer.status, code(answer.body)]).toEqual([404, "NOT_FOUND"]);
    }
    expect(h.query("SELECT count(*) AS n FROM blocks")[0]?.["n"]).toBe(0);
  });

  it("refuses a bad body (400), a cookie without the Origin (403) and too many writes (429)", async () => {
    h.close();
    // Onboarding's PATCH /api/v1/me is a write too.
    h = gameHarness({ LIMIT_WRITES_USER_MINUTE: "3" }, { wrapRepos: faulty });
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    pastOpponents(a, b);
    expect((await call(h, a, "POST", "/api/v1/blocks", { userId: b.id, x: 1 })).status).toBe(400);
    expect((await call(h, a, "POST", "/api/v1/blocks", { userId: "" })).status).toBe(400);
    const noOrigin = await h.request(
      "POST",
      "/api/v1/blocks",
      { userId: b.id },
      { cookie: a.cookie, origin: null },
    );
    expect(noOrigin.status).toBe(403);
    expect((await block(a, b)).status).toBe(204);
    expect((await unblock(a, b)).status).toBe(204);
    const over = await block(a, b);
    expect([over.status, code(over.body)]).toEqual([429, "RATE_LIMITED"]);
  });

  it("needs a session", async () => {
    const response = await h.request("GET", "/api/v1/blocks");
    expect(response.status).toBe(401);
  });

  it("stays open to a re-prompted user, whose unblock is ONBOARDING_REQUIRED (06 §5)", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    pastOpponents(a, b);
    h.exec("UPDATE users SET age_attested_min_age = NULL WHERE id = ?", a.id);
    expect((await block(a, b)).status).toBe(204);
    expect((await listBlocks(a)).status).toBe(200);
    const refused = await unblock(a, b);
    expect([refused.status, code(refused.body)]).toEqual([403, "ONBOARDING_REQUIRED"]);
  });
});

describe("GET /api/v1/blocks (05 §Blocks)", () => {
  it("lists newest first, 100 a page, with a cursor to the rest", async () => {
    const a = await signUp(h, "Ada");
    for (let i = 0; i < 101; i++) {
      const id = crypto.randomUUID();
      h.exec(
        "INSERT INTO users (id, display_name, onboarded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        id,
        `P${String(i)}`,
        now(),
        now(),
        now(),
      );
      h.exec(
        "INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)",
        a.id,
        id,
        now() + i,
      );
    }
    const first = await listBlocks(a);
    expect(first.body.blocks).toHaveLength(100);
    expect(first.body.blocks[0]?.displayName).toBe("P100");
    expect(first.body.nextCursor).not.toBeNull();
    const second = await listBlocks(a, first.body.nextCursor ?? "");
    expect(second.body).toEqual({
      blocks: [expect.objectContaining({ displayName: "P0" })],
      nextCursor: null,
    });
    expect((await listBlocks(a, "not a cursor")).status).toBe(400);
  });
});

describe("DELETE /api/v1/blocks/:userId (05 §Blocks)", () => {
  it("lifts your block only: 204, then 404; past opponents stay deleted", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    pastOpponents(a, b);
    await block(a, b);
    // b can't lift a's block.
    expect((await unblock(b, a)).status).toBe(404);
    expect((await unblock(a, b)).status).toBe(204);
    expect((await unblock(a, b)).status).toBe(404);
    expect((await listBlocks(a)).body.blocks).toEqual([]);
    expect(pairs()).toEqual([]);
  });

  it("is body-less but still needs the Origin", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    pastOpponents(a, b);
    await block(a, b);
    const response = await h.request("DELETE", `/api/v1/blocks/${b.id}`, undefined, {
      cookie: a.cookie,
      origin: null,
    });
    expect(response.status).toBe(403);
  });
});

describe("what a new block changes (06 §6.10)", () => {
  it("deletes the past-opponent pair both ways, so neither can pick the other (04 invariant 6)", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    pastOpponents(a, b);
    pastOpponents(a, c);
    await block(b, a);
    expect(pairs()).toEqual(
      [
        { user_id: a.id, other_id: c.id },
        { user_id: c.id, other_id: a.id },
      ].sort((x, y) => x.user_id.localeCompare(y.user_id)),
    );
    const picked = await call(h, a, "POST", "/api/v1/games", {
      gameType: "words",
      invitees: [{ userId: b.id }],
    });
    expect(code(picked.body)).toBe("INVALID_INVITEES");
  });

  it("removes a joined player from the creator's lobby exactly as Remove would", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const blocked = await lobbyWith(a, [b], 3);
    const removed = await lobbyWith(a, [c], 3);
    const before = versionOf(blocked);
    expect((await block(a, b)).status).toBe(204);
    const { game } = await getGame(h, a, removed);
    const playerId = game.players.find((player) => player.userId === c.id)?.playerId;
    const remove = await call(h, a, "POST", `/api/v1/games/${removed}/remove-seat`, {
      expectedVersion: game.version,
      playerId,
    });
    expect(remove.status).toBe(200);
    const strip = (rows: Record<string, unknown>[]) =>
      rows.map((row) => ({ ...row, user_id: undefined }));
    expect(strip(rowsOf(blocked))).toEqual(strip(rowsOf(removed)));
    expect(versionOf(blocked)).toBe(Number(before) + 1);
    expect((await call(h, b, "GET", `/api/v1/games/${blocked}`)).status).toBe(404);
    const seen = await getGame(h, a, blocked);
    expect(seen.game.players.map((player) => player.state)).toEqual(["joined", "removed"]);
  });

  it("declines the blocker's own seat, joined or invited, exactly as Decline would", async () => {
    const [a, b, c, d] = [
      await signUp(h, "Ada"),
      await signUp(h, "Bo"),
      await signUp(h, "Cy"),
      await signUp(h, "Di"),
    ];
    // b joined a's lobby; b blocks the creator a.
    const joined = await lobbyWith(a, [b, d], 4);
    // c holds a's invitation (a, the creator, is joined): c blocks a.
    const invited = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: c.email }, { email: d.email }],
    });
    expect((await block(b, a)).status).toBe(204);
    expect((await block(c, a)).status).toBe(204);
    expect(rowsOf(joined).map((row) => row["state"])).toEqual(["joined", "declined", "joined"]);
    expect(rowsOf(invited.id).map((row) => row["state"])).toEqual([
      "joined",
      "declined",
      "invited",
    ]);
    // Neither can see the game any more, as after their own decline.
    expect((await call(h, b, "GET", `/api/v1/games/${joined}`)).status).toBe(404);
    expect((await call(h, c, "GET", `/api/v1/games/${invited.id}`)).status).toBe(404);
  });

  it("ends a lobby that can no longer fill, as a decline does", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await createGame(h, a, { gameType: "words", invitees: [{ email: b.email }] });
    await block(b, a);
    expect(statusOf(game.id)).toBe("declined");
  });

  it("declines the blocker's seat when another joined player is the one blocked", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await lobbyWith(a, [b, c], 4);
    await block(b, c);
    expect(rowsOf(game).map((row) => row["state"])).toEqual(["joined", "declined", "joined"]);
  });

  it("removes the creator's own pick, invited or joined", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    pastOpponents(a, b);
    pastOpponents(a, c);
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ userId: b.id }, { userId: c.id }],
    });
    await block(a, b);
    expect(rowsOf(game.id).map((row) => row["state"])).toEqual(["joined", "removed", "invited"]);
  });

  it("makes a typed invitation inert: gone for its holder, unchanged for the creator (S-2, Q3)", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    pastOpponents(a, b);
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }],
    });
    const seen = async () => (await getGame(h, a, game.id)).game.players;
    const before = { players: await seen(), version: versionOf(game.id) };
    expect((await block(a, b)).status).toBe(204);
    // The creator sees the same row, with no version moved: nothing tells whose address it was.
    expect({ players: await seen(), version: versionOf(game.id) }).toEqual(before);
    expect(rowsOf(game.id)[1]).toMatchObject({ state: "invited", delivery: "inert" });
    // For b it is gone, as if removed: not in the list, and the game is a 404.
    expect((await call(h, b, "GET", `/api/v1/games/${game.id}`)).status).toBe(404);
    const listed = await call<{ games: { id: string }[] }>(h, b, "GET", "/api/v1/games");
    expect(listed.body.games.map((row) => row.id)).not.toContain(game.id);
    const accepted = await transition(h, b, game.id, "accept", 0);
    expect(accepted.status).toBe(404);
  });

  it("makes another player's invitation inert, so a member never learns who it is", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }, { email: c.email }],
    });
    await transition(h, b, game.id, "accept");
    pastOpponents(b, c);
    const seen = async () => (await getGame(h, b, game.id)).game.players;
    const before = { players: await seen(), version: versionOf(game.id) };
    await block(b, c);
    expect({ players: await seen(), version: versionOf(game.id) }).toEqual(before);
    expect(rowsOf(game.id).map((row) => [row["state"], row["delivery"]])).toEqual([
      ["joined", "normal"],
      ["joined", "normal"],
      ["invited", "inert"],
    ]);
    expect((await call(h, c, "GET", `/api/v1/games/${game.id}`)).status).toBe(404);
  });

  it("changes nothing in an active game: it carries on, and no pair is written at its end", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await createGame(h, a, { gameType: "example", invitees: [{ email: b.email }] });
    await transition(h, b, game.id, "accept");
    expect(statusOf(game.id)).toBe("active");
    const before = versionOf(game.id);
    expect((await block(a, b)).status).toBe(204);
    expect(versionOf(game.id)).toBe(before);
    await playExampleToEnd(h, game.id, [a, b]);
    expect(statusOf(game.id)).toBe("finished");
    expect(pairs()).toEqual([]);
  });

  it("changes at most the runtime's number of lobbies a call; a repeat changes the rest", async () => {
    h.close();
    h = gameHarness({}, { blockLobbies: 1, wrapRepos: faulty });
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const first = await lobbyWith(a, [b], 3);
    h.advance(1);
    const second = await lobbyWith(a, [b], 3);
    await block(a, b);
    expect([rowsOf(first)[1]?.["state"], rowsOf(second)[1]?.["state"]]).toEqual([
      "removed",
      "joined",
    ]);
    await block(a, b);
    expect(rowsOf(second)[1]?.["state"]).toBe("removed");
  });

  it("leaves a lobby past its expiry alone", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await lobbyWith(a, [b], 3);
    h.advance(15 * DAY);
    await block(a, b);
    expect(rowsOf(game)[1]?.["state"]).toBe("joined");
  });
});

describe("the accept and start checks (02 §4, 05 `/accept`)", () => {
  /** A block written directly, as one made between a load and a write would land. */
  const rawBlock = (blocker: Player, blocked: Player): void => {
    h.exec(
      "INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)",
      blocker.id,
      blocked.id,
      now(),
    );
  };

  const states = (gameId: string) =>
    rowsOf(gameId).map((row) => [row["user_id"], row["state"], row["removed"]]);

  it.each([
    ["the blocker's own Decline", "c blocks b", "c"],
    ["the creator-blocker's Remove", "a blocks c", "a"],
    ["the Decline of the one who blocked the creator", "b blocks a", "b"],
  ] as const)("writes %s at Start, and starts with the rest (A23-S-3)", async (_, __, who) => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await lobbyWith(a, [b, c], 4);
    if (who === "c") rawBlock(c, b);
    if (who === "a") rawBlock(a, c);
    if (who === "b") rawBlock(b, a);
    const started = await transition(h, a, game, "start");
    expect(started.status).toBe(200);
    expect(started.body.game.status).toBe("active");
    expect(states(game)).toEqual(
      who === "c"
        ? [
            [a.id, "playing", 0],
            [b.id, "playing", 0],
            [c.id, "declined", 0],
          ]
        : who === "a"
          ? [
              [a.id, "playing", 0],
              [b.id, "playing", 0],
              [c.id, "removed", 1],
            ]
          : [
              [a.id, "playing", 0],
              [b.id, "declined", 0],
              [c.id, "playing", 0],
            ],
    );
  });

  it("settles a chain in joining order: A–B then B–C leaves C in", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await lobbyWith(a, [b, c], 4);
    rawBlock(a, b);
    rawBlock(b, c);
    expect((await transition(h, a, game, "start")).body.game.status).toBe("active");
    expect(states(game)).toEqual([
      [a.id, "playing", 0],
      [b.id, "removed", 1],
      [c.id, "playing", 0],
    ]);
  });

  it("writes the effect and answers NOT_ENOUGH_PLAYERS when too few would remain", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await lobbyWith(a, [b], 3);
    rawBlock(a, b);
    const before = versionOf(game);
    const started = await transition(h, a, game, "start");
    expect([started.status, code(started.body)]).toEqual([409, "NOT_ENOUGH_PLAYERS"]);
    expect(states(game)).toEqual([
      [a.id, "joined", 0],
      [b.id, "removed", 1],
    ]);
    expect(versionOf(game)).toBe(Number(before) + 1);
    expect(statusOf(game)).toBe("lobby");
  });

  it("ends a lobby a Decline at Start leaves unable to fill, as a decline would", async () => {
    const [c, d] = [await signUp(h, "Cy"), await signUp(h, "Di")];
    const lobby = await createGame(h, c, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: d.email }],
    });
    await transition(h, d, lobby.id, "accept");
    rawBlock(d, c);
    const started = await transition(h, c, lobby.id, "start");
    expect([started.status, code(started.body)]).toEqual([409, "NOT_ENOUGH_PLAYERS"]);
    expect(statusOf(lobby.id)).toBe("declined");
    expect(states(lobby.id)).toEqual([
      [c.id, "joined", 0],
      [d.id, "declined", 0],
    ]);
  });

  it("writes the effect on an accept, and the automatic start then doesn't happen", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }, { email: c.email }],
    });
    await transition(h, b, game.id, "accept");
    rawBlock(a, b);
    const accepted = await transition(h, c, game.id, "accept");
    expect(accepted.status).toBe(200);
    expect(accepted.body.game.status).toBe("lobby");
    expect(rowsOf(game.id).map((row) => row["state"])).toEqual(["joined", "removed", "joined"]);
  });

  it("declines an accept with a block against any joined member and answers 404 (backstop)", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }, { email: c.email }],
    });
    await transition(h, b, game.id, "accept");
    rawBlock(b, c);
    const accepted = await transition(h, c, game.id, "accept");
    expect([accepted.status, code(accepted.body)]).toEqual([404, "NOT_FOUND"]);
    expect(rowsOf(game.id).map((row) => row["state"])).toEqual(["joined", "joined", "declined"]);
  });

  it("holds back an accept that raced a block: nothing written, and the retry is refused (A23-S-4)", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }, { email: c.email }],
    });
    await transition(h, b, game.id, "accept");
    rawBlock(b, c);
    const before = { rows: rowsOf(game.id), version: versionOf(game.id) };
    // The accept's own read of blocks misses the block, as if it landed just after: the guard in
    // the accept's batch still holds it back.
    faults.missBlocks = 1;
    const raced = await transition(h, c, game.id, "accept");
    expect([raced.status, code(raced.body)]).toEqual([409, "STALE_GAME"]);
    expect({ rows: rowsOf(game.id), version: versionOf(game.id) }).toEqual(before);
    const again = await transition(h, c, game.id, "accept");
    expect([again.status, code(again.body)]).toEqual([404, "NOT_FOUND"]);
  });

  it("holds back a link join that raced a block, and the join's retry refuses it (A23-S-4)", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await lobbyWith(a, [b], 3);
    const link = await call<{ url: string }>(h, a, "POST", `/api/v1/games/${game}/join-link`, {});
    const token = new URL(link.body.url).hash.slice(1);
    rawBlock(b, c);
    const before = rowsOf(game);
    // The join's first read misses the block; its batch's guard makes it stale, and the retry's
    // read finds the block: the same 404 as any refusal.
    faults.missBlocks = 1;
    const joined = await call(h, c, "POST", "/api/v1/join", { token });
    expect([joined.status, code(joined.body)]).toEqual([404, "NOT_FOUND"]);
    expect(rowsOf(game)).toEqual(before);
  });
});

describe("a block's leftovers converge (A23-S-3)", () => {
  it("a lobby past the per-call cap gets the blocker's own Decline at its Start, never the blocked's removal", async () => {
    h.close();
    h = gameHarness({}, { blockLobbies: 1, wrapRepos: faulty });
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const first = await lobbyWith(a, [b, c], 4);
    h.advance(1);
    const second = await lobbyWith(a, [b, c], 4);
    await block(b, c);
    expect(rowsOf(first).map((row) => row["state"])).toEqual(["joined", "declined", "joined"]);
    expect(rowsOf(second).map((row) => row["state"])).toEqual(["joined", "joined", "joined"]);
    expect((await transition(h, a, second, "start")).body.game.status).toBe("active");
    expect(rowsOf(second).map((row) => [row["user_id"], row["state"], row["removed"]])).toEqual([
      [a.id, "playing", 0],
      [b.id, "declined", 0],
      [c.id, "playing", 0],
    ]);
  });

  it("a lobby the blocker owns gets their Remove at an accept", async () => {
    h.close();
    h = gameHarness({}, { blockLobbies: 1, wrapRepos: faulty });
    const [b, c, d] = [await signUp(h, "Bo"), await signUp(h, "Cy"), await signUp(h, "Di")];
    const first = await lobbyWith(b, [c], 3);
    h.advance(1);
    const second = await createGame(h, b, {
      gameType: "example",
      seats: 4,
      invitees: [{ email: c.email }, { email: d.email }],
    });
    await transition(h, c, second.id, "accept");
    await block(b, c);
    expect(rowsOf(first)[1]?.["state"]).toBe("removed");
    expect(rowsOf(second.id)[1]?.["state"]).toBe("joined");
    expect((await transition(h, d, second.id, "accept")).status).toBe(200);
    expect(rowsOf(second.id).map((row) => row["state"])).toEqual(["joined", "removed", "joined"]);
  });
});

describe("a block in a rematch's accept (05 `/rematch`, A23-P-7)", () => {
  it("declines the invitation and answers 404 when a block with a joined member is found", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }, { email: c.email }],
    });
    for (const other of [b, c]) await transition(h, other, game.id, "accept");
    await playExampleToEnd(h, game.id, [a, b, c]);
    h.advance(DAY);
    const made = await call<{ game: { id: string } }>(
      h,
      a,
      "POST",
      `/api/v1/games/${game.id}/rematch`,
      {},
    );
    expect(made.status).toBe(201);
    // A block racing the invitation's delivery: b's invitation is still normal.
    h.exec(
      "INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)",
      a.id,
      b.id,
      now(),
    );
    const answer = await call(h, b, "POST", `/api/v1/games/${game.id}/rematch`, {});
    expect([answer.status, code(answer.body)]).toEqual([404, "NOT_FOUND"]);
    expect(rowsOf(made.body.game.id).find((row) => row["user_id"] === b.id)?.["state"]).toBe(
      "declined",
    );
  });
});

describe("a block's lobby changes that keep losing races (A23-P-7, P-16)", () => {
  it("retries a lost race and writes the effect", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await lobbyWith(a, [b], 3);
    faults.loseRaces = 2;
    expect((await block(a, b)).status).toBe(204);
    expect(rowsOf(game)[1]?.["state"]).toBe("removed");
  });

  it("stops after its attempts, logs it, and still answers 204; the Start then writes it", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await lobbyWith(a, [b, c], 4);
    faults.loseRaces = 4;
    expect((await block(a, b)).status).toBe(204);
    expect(rowsOf(game)[1]?.["state"]).toBe("joined");
    expect(h.logs.some((line) => line["msg"] === "block's lobby change kept losing races")).toBe(
      true,
    );
    expect((await transition(h, a, game, "start")).body.game.status).toBe("active");
    expect(rowsOf(game)[1]?.["state"]).toBe("removed");
  });
});
