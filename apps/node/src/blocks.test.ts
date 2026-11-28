/**
 * Blocking (alpha A23; docs/spec/05-api.md §Blocks, 06 §6.10, 02 §4, 04 invariant 6, Q29): the
 * endpoints and their refusals, what a new block changes in shared lobbies and what it must leave
 * alone (Q3), the accept and start checks, active games carrying on, and a rematch's inert
 * invitation. The real app on a real SQLite database with the installed games.
 */
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

let h: Harness;
beforeEach(() => {
  h = gameHarness();
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

  it("blocks anyone who holds or held any row in a game with you, in any state", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    // b declined a's invitation: the row stays, so a can still block b, and b can block a.
    const declined = await createGame(h, a, { gameType: "words", invitees: [{ email: b.email }] });
    expect((await transition(h, b, declined.id, "decline")).status).toBe(204);
    expect((await block(a, b)).status).toBe(204);
    expect((await block(b, a)).status).toBe(204);
    // c holds an open invitation from a: a and c can block each other.
    await createGame(h, a, { gameType: "words", invitees: [{ email: c.email }] });
    expect((await block(c, a)).status).toBe(204);
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
    h = gameHarness({ LIMIT_WRITES_USER_MINUTE: "3" });
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

  it("leaves a typed invitation alone, so the creator never learns whose address it is (Q3)", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    pastOpponents(a, b);
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }],
    });
    const before = { rows: rowsOf(game.id), version: versionOf(game.id) };
    expect((await block(a, b)).status).toBe(204);
    expect({ rows: rowsOf(game.id), version: versionOf(game.id) }).toEqual(before);
    // The accept check keeps them apart: b's accept is declined and answered 404 (05 `/accept`).
    const accepted = await transition(h, b, game.id, "accept");
    expect([accepted.status, code(accepted.body)]).toEqual([404, "NOT_FOUND"]);
    expect(rowsOf(game.id)[1]).toMatchObject({ state: "declined", invite_email: null });
    // To the creator it is a decline like any other.
    expect((await getGame(h, a, game.id)).game.players[1]).toMatchObject({
      state: "declined",
      displayName: null,
      userId: null,
    });
  });

  it("leaves another player's unjoined invitation alone, so a member never learns who it is", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }, { email: c.email }],
    });
    await transition(h, b, game.id, "accept");
    pastOpponents(b, c);
    const before = { rows: rowsOf(game.id), version: versionOf(game.id) };
    await block(b, c);
    expect({ rows: rowsOf(game.id), version: versionOf(game.id) }).toEqual(before);
    const accepted = await transition(h, c, game.id, "accept");
    expect(accepted.status).toBe(404);
    expect(rowsOf(game.id).map((row) => row["state"])).toEqual(["joined", "joined", "declined"]);
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
    h = gameHarness({}, { blockLobbies: 1 });
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

  it("removes the later-joined of a blocked pair at Start and starts with the rest", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await lobbyWith(a, [b, c], 4);
    rawBlock(c, b);
    const started = await transition(h, a, game, "start");
    expect(started.status).toBe(200);
    expect(started.body.game.status).toBe("active");
    expect(rowsOf(game).map((row) => [row["user_id"], row["state"], row["removed"]])).toEqual([
      [a.id, "playing", 0],
      [b.id, "playing", 0],
      [c.id, "removed", 1],
    ]);
  });

  it("refuses Start with NOT_ENOUGH_PLAYERS, writing nothing, when too few would remain", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await lobbyWith(a, [b], 3);
    rawBlock(a, b);
    const before = { rows: rowsOf(game), version: versionOf(game) };
    const started = await transition(h, a, game, "start");
    expect([started.status, code(started.body)]).toEqual([409, "NOT_ENOUGH_PLAYERS"]);
    expect({ rows: rowsOf(game), version: versionOf(game) }).toEqual(before);
  });

  it("applies the re-check to an automatic start on the last accept", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }, { email: c.email }],
    });
    await transition(h, b, game.id, "accept");
    rawBlock(a, b);
    const accepted = await transition(h, c, game.id, "accept");
    expect(accepted.body.game.status).toBe("active");
    expect(rowsOf(game.id).map((row) => row["state"])).toEqual(["playing", "removed", "playing"]);
  });

  it("declines an accept with a block against any joined member and answers 404", async () => {
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
});

describe("a rematch's inert invitation (Q29, 06 §6.11)", () => {
  it("shows its holder no place in the rematch, while the others see them invited", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }, { email: c.email }],
    });
    for (const other of [b, c]) await transition(h, other, game.id, "accept");
    await playExampleToEnd(h, game.id, [a, b, c]);
    h.advance(DAY);
    expect((await block(b, c)).status).toBe(204);
    const made = await call<{ game: { id: string; players: { state: string }[] } }>(
      h,
      a,
      "POST",
      `/api/v1/games/${game.id}/rematch`,
      {},
    );
    expect(made.status).toBe(201);
    const later = rowsOf(made.body.game.id).find((row) => row["delivery"] === "inert");
    expect(later).toBeDefined();
    const holder = later?.["user_id"] === b.id ? b : c;
    const other = holder === b ? c : b;
    expect((await getGame(h, holder, game.id)).game.rematch).toEqual({
      gameId: made.body.game.id,
      you: "none",
    });
    expect((await getGame(h, other, game.id)).game.rematch?.you).toBe("invited");
    expect(made.body.game.players.map((player) => player.state)).toEqual([
      "joined",
      "invited",
      "invited",
    ]);
  });
});
