/**
 * Rematch (alpha A15; docs/spec/05-api.md `POST /api/v1/games/:id/rematch`, 06 §6.11, 04
 * `rematch_game_id`): who may ask, the first call creating the rematch through the creation path
 * of `POST /api/v1/games` with everything it checks, later calls answering with that one rematch
 * (accepting an invitation in it), and the finished game's `rematch` field. The real app on a real
 * SQLite database with the installed games.
 */
import type { GameEnvelope } from "@your-move/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  act,
  call,
  createGame,
  type ErrorBody,
  type ExampleView,
  gameHarness,
  getGame,
  playExampleToEnd,
  type Player,
  signUp,
  transition,
} from "./games-support.js";
import { DAY, type Harness, MINUTE } from "./test-harness.js";

let h: Harness;
beforeEach(() => {
  h = gameHarness();
});
afterEach(() => {
  h.close();
});

const code = (body: unknown): string | undefined => (body as Partial<ErrorBody>).error?.code;

type Answer = { game: GameEnvelope } & ErrorBody;

const rematch = (player: Player, gameId: string, body: unknown = {}) =>
  call<Answer>(h, player, "POST", `/api/v1/games/${gameId}/rematch`, body);

/** A stored final view and summary, for a game finished by hand. */
const FINAL = { view: null, summary: { headline: [] } };

const gameCount = (): unknown => h.query("SELECT count(*) AS n FROM games")[0]?.["n"];

const linkOf = (gameId: string): unknown =>
  h.query("SELECT rematch_game_id FROM games WHERE id = ?", gameId)[0]?.["rematch_game_id"];

/** A finished example game between `players`, the first its creator; every seat has acted. */
async function finished(
  players: readonly Player[],
  body: Record<string, unknown> = {},
): Promise<GameEnvelope> {
  const [creator, ...others] = players;
  if (creator === undefined) throw new Error("no players");
  const game = await createGame(h, creator, {
    gameType: "example",
    seats: players.length,
    invitees: others.map((other) => ({ email: other.email })),
    ...body,
  });
  for (const other of others) {
    const accepted = await transition(h, other, game.id, "accept");
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  }
  await playExampleToEnd(h, game.id, players);
  const ended = (await getGame(h, creator, game.id)).game;
  expect(ended.status).toBe("finished");
  // Lobby and daily limits start afresh for what each test does next.
  h.advance(DAY);
  return ended;
}

describe("who may ask for a rematch (05, 06 §6.11)", () => {
  it("answers a non-player exactly as reading the game does: 404, and creates nothing", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const stranger = await signUp(h, "Stranger");
    const game = await finished([a, b]);
    const before = gameCount();
    const asked = await rematch(stranger, game.id);
    const read = await call(h, stranger, "GET", `/api/v1/games/${game.id}`);
    expect([asked.status, read.status]).toEqual([404, 404]);
    expect(asked.body).toEqual(read.body);
    const unknown = await rematch(stranger, crypto.randomUUID());
    expect(unknown.body).toEqual(read.body);
    expect(gameCount()).toBe(before);
    expect(linkOf(game.id)).toBeNull();
  });

  it("refuses a game that isn't finished: 409 WRONG_STATUS for its members", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const lobby = await createGame(h, a, { gameType: "example", invitees: [{ email: b.email }] });
    expect([(await rematch(a, lobby.id)).status, code((await rematch(b, lobby.id)).body)]).toEqual([
      409,
      "WRONG_STATUS",
    ]);
    await transition(h, b, lobby.id, "accept");
    const active = await rematch(a, lobby.id);
    expect([active.status, code(active.body)]).toEqual([409, "WRONG_STATUS"]);
    // A game that ended any other way has no rematch either.
    const cancelled = await createGame(h, a, {
      gameType: "example",
      invitees: [{ email: b.email }],
    });
    await transition(h, a, cancelled.id, "cancel");
    expect(code((await rematch(a, cancelled.id)).body)).toBe("WRONG_STATUS");
  });

  it("takes no input: no body or `{}`, nothing else", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await finished([a, b]);
    // No body at all is fine: the endpoint takes no input.
    const response = await h.request("POST", `/api/v1/games/${game.id}/rematch`, undefined, {
      cookie: a.cookie,
    });
    expect(response.status).toBe(201);
    const extra = await rematch(b, game.id, { seats: 3 });
    expect([extra.status, code(extra.body)]).toEqual([400, "BAD_REQUEST"]);
  });
});

describe("the first call creates the rematch (05)", () => {
  it("through the creation path: the same setup, the caller first, the others invited", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await finished([a, b, c], {
      options: { lives: 1, handSize: 4 },
      turnTimeoutDays: 5,
      seatOrder: "join",
    });
    const asked = await rematch(c, game.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const made = asked.body.game;
    expect(made).toMatchObject({
      gameType: "example",
      options: game.options,
      turnTimeoutDays: 5,
      seatOrder: "join",
      aiAssistance: "off",
      // Two people carried over are two picks: every pick is an invitation (Q29, 06 §6.1), so it
      // waits for their accepts.
      status: "lobby",
      yourSeat: null,
    });
    // The caller first, then the others in their old seat order (02 §4 `join`).
    const oldOrder = game.players
      .filter((player) => player.userId !== c.id)
      .sort((x, y) => (x.seat ?? 0) - (y.seat ?? 0))
      .map((player) => player.userId ?? "");
    expect(
      h.query("SELECT user_id, state FROM game_players WHERE game_id = ? ORDER BY rowid", made.id),
    ).toEqual([
      { user_id: c.id, state: "joined" },
      ...oldOrder.map((id) => ({ user_id: id, state: "invited" })),
    ]);
    const byId = new Map([a, b].map((player) => [player.id, player]));
    for (const id of oldOrder) {
      const player = byId.get(id);
      if (player === undefined) throw new Error("not carried over");
      expect((await transition(h, player, made.id, "accept")).status).toBe(200);
    }
    const started = (await getGame(h, c, made.id)).game;
    expect(started.status).toBe("active");
    expect(
      [...started.players].sort((x, y) => (x.seat ?? 0) - (y.seat ?? 0)).map((p) => p.userId),
    ).toEqual([c.id, ...oldOrder]);
    expect(made.players.find((player) => player.isCreator)?.userId).toBe(c.id);
    expect(linkOf(game.id)).toBe(made.id);
    // The caller's remembered options are neither read nor written.
    expect(h.query("SELECT settings FROM users WHERE id = ?", c.id)[0]?.["settings"]).toBe("{}");
  });

  it("shows the rematch to every player of the finished game, with their own place in it", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await finished([a, b]);
    for (const player of [a, b])
      expect((await getGame(h, player, game.id)).game.rematch).toBeNull();
    const made = (await rematch(a, game.id)).body.game;
    for (const player of [a, b]) {
      expect((await getGame(h, player, game.id)).game.rematch).toEqual({
        gameId: made.id,
        you: "joined",
      });
    }
    // Only a finished game has the field at all.
    expect("rematch" in (await getGame(h, a, made.id)).game).toBe(false);
  });

  it("re-resolves the stored options: ones the module no longer accepts are INVALID_OPTIONS", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await finished([a, b]);
    // As if a newer module version had narrowed the range of a stored option.
    h.exec(
      "UPDATE games SET options = ? WHERE id = ?",
      JSON.stringify({ handSize: 9, lives: 2 }),
      game.id,
    );
    const before = gameCount();
    const asked = await rematch(a, game.id);
    expect([asked.status, code(asked.body)]).toEqual([400, "INVALID_OPTIONS"]);
    expect((asked.body.error.detail as { code: string }).code).toBe("OPTION_OUT_OF_RANGE");
    expect(gameCount()).toBe(before);
    expect(linkOf(game.id)).toBeNull();
  });

  it("carries over no deleted account: one seat fewer, so it starts with those left", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await finished([a, b, c]);
    // The last step of account deletion (04): the row goes, its seats keep no user.
    h.exec("DELETE FROM sessions WHERE user_id = ?", c.id);
    h.exec("DELETE FROM users WHERE id = ?", c.id);
    const asked = await rematch(a, game.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body.game.status).toBe("active");
    expect(asked.body.game.players.map((player) => player.userId)).toEqual([a.id, b.id]);
    expect(h.query("SELECT seats FROM games WHERE id = ?", asked.body.game.id)[0]?.["seats"]).toBe(
      2,
    );
  });

  it("carries over no one who never acted in the game (A15-P-3)", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }, { email: c.email }],
    });
    for (const other of [b, c]) await transition(h, other, game.id, "accept");
    // Cy declines before a first action; the other two play it out.
    expect((await transition(h, c, game.id, "decline")).status).toBe(200);
    await playExampleToEnd(h, game.id, [a, b]);
    h.advance(DAY);
    const asked = await rematch(b, game.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body.game.players.map((player) => player.userId)).toEqual([b.id, a.id]);
    // The one who declined can still ask: only those who acted come along.
    expect((await rematch(c, game.id)).status).toBe(404);
  });

  it("answers REMATCH_UNAVAILABLE when too few are left, creating and counting nothing", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await finished([a, b]);
    h.exec("DELETE FROM sessions WHERE user_id = ?", b.id);
    h.exec("DELETE FROM users WHERE id = ?", b.id);
    const counted = () => h.query("SELECT key, count FROM rate_limits WHERE key LIKE 'GAMES_%'");
    const before = [gameCount(), counted()];
    const asked = await rematch(a, game.id);
    expect([asked.status, code(asked.body)]).toEqual([409, "REMATCH_UNAVAILABLE"]);
    expect([gameCount(), counted()]).toEqual(before);
    expect(linkOf(game.id)).toBeNull();
  });

  it("refuses when another player can no longer be picked, as POST /games does (06 §6.11)", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await finished([a, b]);
    // b blocks a (nothing writes blocks through the API before M4): the pair is gone too.
    h.exec(
      "INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)",
      b.id,
      a.id,
      h.platform.now().getTime(),
    );
    h.exec("DELETE FROM past_opponents WHERE user_id IN (?, ?)", a.id, b.id);
    const counted = () => h.query("SELECT key, count FROM rate_limits WHERE key LIKE 'GAMES_%'");
    const before = counted();
    const asked = await rematch(a, game.id);
    // No creation limit is counted for the refused call.
    expect(counted()).toEqual(before);
    const picked = await call(h, a, "POST", "/api/v1/games", {
      gameType: "example",
      invitees: [{ userId: b.id }],
    });
    expect([asked.status, code(asked.body)]).toEqual([400, "INVALID_INVITEES"]);
    expect(asked.body).toEqual(picked.body);
    expect(linkOf(game.id)).toBeNull();
  });

  it("applies the creation limits: TOO_MANY_GAMES, and the daily pair limit", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await finished([a, b]);
    for (let i = 0; i < 5; i++) {
      await createGame(h, a, { gameType: "example", invitees: [{ userId: b.id }] });
      h.advance(DAY);
    }
    const over = await rematch(a, game.id);
    expect([over.status, code(over.body)]).toEqual([409, "TOO_MANY_GAMES"]);
    expect(linkOf(game.id)).toBeNull();
    // b created none of those games: b's own call creates it.
    const bAsks = await rematch(b, game.id);
    expect(bAsks.status).toBe(201);
    expect(bAsks.body.game.players.find((player) => player.isCreator)?.userId).toBe(b.id);

    h.close();
    h = gameHarness({ LIMIT_GAMES_CREATED_PAIR_DAY: "1" });
    const [c, d] = [await signUp(h, "Cy"), await signUp(h, "Di")];
    const other = await finished([c, d]);
    await createGame(h, c, { gameType: "example", invitees: [{ userId: d.id }] });
    const limited = await rematch(c, other.id);
    expect([limited.status, code(limited.body)]).toEqual([429, "RATE_LIMITED"]);
  });

  it("words: re-resolves and stores the options at their current versions", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    // Past opponents through a finished game, then a words game between them that finished (as
    // if played out) with an older ruleset version stored.
    await finished([a, b]);
    const words = await createGame(h, a, { gameType: "words", invitees: [{ userId: b.id }] });
    const current = words.options as Record<string, unknown>;
    h.exec(
      "UPDATE games SET status = 'finished', ended_at = ?, final_views = ?, options = ? WHERE id = ?",
      h.platform.now().getTime(),
      JSON.stringify({ seats: [FINAL, FINAL], public: FINAL }),
      JSON.stringify({ ...current, rulesetVersion: 0 }),
      words.id,
    );
    // As if both had played.
    h.exec("UPDATE game_players SET acted_once = 1 WHERE game_id = ?", words.id);
    h.advance(DAY);
    const asked = await rematch(b, words.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body.game.options).toEqual(current);
  });
});

describe("version keys in option input (02 §2.1 rule 10, A15-S-2, A15-P-10)", () => {
  it("refuses a version that isn't a non-negative integer, and never remembers one", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const bad = await call(h, a, "POST", "/api/v1/games", {
      gameType: "words",
      options: { rulesetVersion: "1" },
      invitees: [{ email: b.email }],
    });
    expect([bad.status, code(bad.body)]).toEqual([400, "INVALID_OPTIONS"]);
    expect((bad.body as ErrorBody).error.detail).toEqual({
      code: "INVALID_OPTION",
      detail: { option: "rulesetVersion" },
    });
    const made = await createGame(h, a, {
      gameType: "words",
      options: { rulesetId: "casual", rulesetVersion: 0, dictionaryVersion: 7 },
      invitees: [{ email: b.email }],
    });
    // Never honoured: the game has the current versions.
    expect((made.options as { rulesetVersion: number }).rulesetVersion).toBeGreaterThan(0);
    const settings = String(
      h.query("SELECT settings FROM users WHERE id = ?", a.id)[0]?.["settings"],
    );
    expect(JSON.parse(settings)).toMatchObject({ lastOptions: { words: { rulesetId: "casual" } } });
    expect(settings).not.toMatch(/Version/u);
  });
});

describe("a finished game has one rematch (05, 04 `rematch_game_id`)", () => {
  it("answers every later call with the same game, creating nothing more", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await finished([a, b]);
    const first = await rematch(a, game.id);
    expect(first.status).toBe(201);
    const count = gameCount();
    for (const player of [b, a, b]) {
      const again = await rematch(player, game.id);
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.body.game.id).toBe(first.body.game.id);
    }
    expect(gameCount()).toBe(count);
    // b, added at once, gets their own envelope of it.
    expect((await rematch(b, game.id)).body.game.players.find((p) => p.isYou)?.userId).toBe(b.id);
  });

  it("of two presses at once, exactly one creates it and both get it", async () => {
    const games = h.platform.repos.games;
    const real = games.createRematch.bind(games);
    const created: boolean[] = [];
    games.createRematch = async (...args) => {
      const result = await real(...args);
      created.push(result);
      return result;
    };
    for (let round = 0; round < 5; round++) {
      const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
      const game = await finished([a, b]);
      const count = Number(gameCount());
      created.length = 0;
      const answers = await Promise.all([rematch(a, game.id), rematch(b, game.id)]);
      // One insert won; a second press either saw the link or lost the guarded insert.
      expect(created.filter((result) => result)).toHaveLength(1);
      expect(created.length).toBeLessThanOrEqual(2);
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 201]);
      const [first, second] = answers;
      expect(first.body.game.id).toBe(second.body.game.id);
      expect(Number(gameCount())).toBe(count + 1);
      expect(linkOf(game.id)).toBe(first.body.game.id);
    }
  });

  it("answers a call that lost the race to create it with the winner's game, creating nothing", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await finished([a, b]);
    const games = h.platform.repos.games;
    const real = games.createRematch.bind(games);
    let winner: Answer | undefined;
    const created: boolean[] = [];
    const spied: typeof real = async (...args) => {
      const result = await real(...args);
      created.push(result);
      return result;
    };
    // b's press lands while a's is between its checks and its insert.
    games.createRematch = async (...args) => {
      games.createRematch = spied;
      winner = (await rematch(b, game.id)).body;
      return spied(...args);
    };
    const count = Number(gameCount());
    const lost = await rematch(a, game.id);
    // The guarded insert really ran for both: b's won, a's wrote nothing (A15-P-7).
    expect(created).toEqual([true, false]);
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);
    expect(lost.body.game.id).toBe(winner?.game.id);
    expect(lost.body.game.players.find((player) => player.isCreator)?.userId).toBe(b.id);
    expect(Number(gameCount())).toBe(count + 1);
  });

  it("accepts the invitation of a call that lost the race to it (A15-P-6)", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await finished([a, b]);
    h.exec("UPDATE users SET settings = ? WHERE id = ?", '{"whoCanAddMe":"nobody"}', b.id);
    const games = h.platform.repos.games;
    const real = games.createRematch.bind(games);
    const created: boolean[] = [];
    const spied: typeof real = async (...args) => {
      const result = await real(...args);
      created.push(result);
      return result;
    };
    // a's press wins while b's is between its checks and its insert: b holds an invitation.
    games.createRematch = async (...args) => {
      games.createRematch = spied;
      expect((await rematch(a, game.id)).body.game.status).toBe("lobby");
      return spied(...args);
    };
    const lost = await rematch(b, game.id);
    expect(created).toEqual([true, false]);
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);
    expect(lost.body.game).toMatchObject({ id: linkOf(game.id), status: "active" });
    expect(lost.body.game.players.find((player) => player.isCreator)?.userId).toBe(a.id);
  });

  it("retries an accept that lost its race once, and gives up with STALE_GAME (A15-P-6)", async () => {
    const [a, b, c, d] = [
      await signUp(h, "Ada"),
      await signUp(h, "Bo"),
      await signUp(h, "Cy"),
      await signUp(h, "Di"),
    ];
    const games = h.platform.repos.games;
    const real = games.applyTransition.bind(games);
    for (const [first, second, staleTimes, expected] of [
      [a, b, 1, 200],
      [c, d, Infinity, 409],
    ] as const) {
      const game = await finished([first, second]);
      h.exec("UPDATE users SET settings = ? WHERE id = ?", '{"whoCanAddMe":"nobody"}', second.id);
      const made = (await rematch(first, game.id)).body.game;
      let attempts = 0;
      games.applyTransition = async (...args) => {
        attempts += 1;
        return attempts <= staleTimes ? "stale" : real(...args);
      };
      const asked = await rematch(second, game.id);
      games.applyTransition = real;
      expect(asked.status, JSON.stringify(asked.body)).toBe(expected);
      if (expected === 200) {
        expect(attempts).toBe(2);
        expect(asked.body.game).toMatchObject({ id: made.id, status: "active" });
      } else {
        // One try and 3 retries, as every server-started transition (03 §5.2, A18-P2-4).
        expect(attempts).toBe(4);
        expect(code(asked.body)).toBe("STALE_GAME");
        expect((await getGame(h, second, game.id)).game.rematch?.you).toBe("invited");
      }
    }
  });

  it("answers a call refused by a limit with the rematch another player made meanwhile", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await finished([a, b]);
    for (let i = 0; i < 5; i++) {
      await createGame(h, a, { gameType: "example", invitees: [{ userId: b.id }] });
      h.advance(DAY);
    }
    const games = h.platform.repos.games;
    const real = games.countLiveCreatedWithUser.bind(games);
    let winner: Answer | undefined;
    games.countLiveCreatedWithUser = async (...args) => {
      games.countLiveCreatedWithUser = real;
      winner = (await rematch(b, game.id)).body;
      return real(...args);
    };
    const answered = await rematch(a, game.id);
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body.game.id).toBe(winner?.game.id);
  });

  it("accepts the caller's invitation in it: 'Accept rematch'", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await finished([a, b]);
    h.exec("UPDATE users SET settings = ? WHERE id = ?", '{"whoCanAddMe":"nobody"}', b.id);
    const made = (await rematch(a, game.id)).body.game;
    expect(made.status).toBe("lobby");
    expect((await getGame(h, b, game.id)).game.rematch).toEqual({
      gameId: made.id,
      you: "invited",
    });
    expect((await getGame(h, a, game.id)).game.rematch).toEqual({
      gameId: made.id,
      you: "joined",
    });
    const accepted = await rematch(b, game.id);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.game).toMatchObject({ id: made.id, status: "active" });
    expect(
      h.query(
        "SELECT joined_via FROM game_players WHERE game_id = ? AND user_id = ?",
        made.id,
        b.id,
      ),
    ).toEqual([{ joined_via: "invitation" }]);
    expect((await getGame(h, b, game.id)).game.rematch?.you).toBe("joined");
  });

  it("doesn't take back a player who declined it: 404, and 'none' on the finished game", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await finished([a, b, c]);
    h.exec("UPDATE users SET settings = ? WHERE id = ?", '{"whoCanAddMe":"nobody"}', b.id);
    const made = (await rematch(a, game.id)).body.game;
    expect((await transition(h, b, made.id, "decline")).status).toBe(204);
    const asked = await rematch(b, game.id);
    const read = await call(h, b, "GET", `/api/v1/games/${made.id}`);
    expect([asked.status, code(asked.body)]).toEqual([404, "NOT_FOUND"]);
    expect(asked.body).toEqual(read.body);
    expect((await getGame(h, b, game.id)).game.rematch).toEqual({ gameId: made.id, you: "none" });
    expect(
      h.query("SELECT state FROM game_players WHERE game_id = ? AND user_id = ?", made.id, b.id),
    ).toEqual([{ state: "declined" }]);
  });
});

describe("a rematch that never got going may be replaced (A15-P-2, 04 `rematch_game_id`)", () => {
  it("replaces one whose lobby was declined: the button says Rematch again", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await finished([a, b]);
    h.exec("UPDATE users SET settings = ? WHERE id = ?", '{"whoCanAddMe":"nobody"}', b.id);
    const first = (await rematch(a, game.id)).body.game;
    expect((await transition(h, b, first.id, "decline")).status).toBe(204);
    expect((await getGame(h, a, first.id)).game.status).toBe("declined");
    for (const player of [a, b])
      expect((await getGame(h, player, game.id)).game.rematch).toBeNull();
    const again = await rematch(b, game.id);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.game.id).not.toBe(first.id);
    expect(again.body.game.players.find((player) => player.isCreator)?.userId).toBe(b.id);
    expect(linkOf(game.id)).toBe(again.body.game.id);
  });

  it("replaces one whose lobby expired, expiring it first", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await finished([a, b, c]);
    h.exec("UPDATE users SET settings = ? WHERE id = ?", '{"whoCanAddMe":"nobody"}', b.id);
    const first = (await rematch(a, game.id)).body.game;
    // Past its 14 days: no one is offered the old lobby any more.
    h.advance(15 * DAY);
    expect((await getGame(h, b, game.id)).game.rematch).toBeNull();
    const again = await rematch(b, game.id);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect((await getGame(h, a, first.id)).game.status).toBe("expired");
    expect(linkOf(game.id)).toBe(again.body.game.id);
  });

  it("replaces one that ended declined even after a move: someone refused it (A15-R2-1)", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await finished([a, b]);
    const first = (await rematch(a, game.id)).body.game;
    expect(first.status).toBe("active");
    // Ada plays her first card, then Bo declines before playing his: the game ends `declined`
    // with one action logged, and every declined ending is unplayed (02 §2.1 rule 9).
    const { view } = await getGame(h, a, first.id);
    const card = (view as ExampleView).seats[0]?.hand?.[0];
    expect((await act(h, a, first.id, { card })).status).toBe(200);
    expect((await transition(h, b, first.id, "decline")).body.game.status).toBe("declined");
    expect((await getGame(h, b, game.id)).game.rematch).toBeNull();
    const again = await rematch(b, game.id);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(linkOf(game.id)).toBe(again.body.game.id);
  });

  it("never replaces one an operator cancelled (A15-S2-1)", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await finished([a, b]);
    const first = (await rematch(a, game.id)).body.game;
    // An operator's cancel of the active rematch (02 §4; the Admin API is M3's): written by hand.
    h.exec(
      "UPDATE games SET status = 'cancelled', end_reason = 'operator_cancelled', ended_at = ? WHERE id = ?",
      h.platform.now().getTime(),
      first.id,
    );
    expect((await getGame(h, b, game.id)).game.rematch).toEqual({
      gameId: first.id,
      you: "joined",
    });
    const again = await rematch(b, game.id);
    expect([again.status, again.body.game.id]).toEqual([200, first.id]);
  });

  it("stops press, decline, press… at the daily pair limit (A15-S2-2)", async () => {
    h.close();
    h = gameHarness({ LIMIT_GAMES_CREATED_PAIR_DAY: "2" });
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await finished([a, b]);
    h.exec("UPDATE users SET settings = ? WHERE id = ?", '{"whoCanAddMe":"nobody"}', b.id);
    for (let round = 0; round < 2; round++) {
      const made = await rematch(a, game.id);
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      expect((await transition(h, b, made.body.game.id, "decline")).status).toBe(204);
    }
    const count = gameCount();
    const limited = await rematch(a, game.id);
    expect([limited.status, code(limited.body)]).toEqual([429, "RATE_LIMITED"]);
    expect(gameCount()).toBe(count);
  });
});

describe("a rematch whose guarded insert keeps losing (A15-R2-2)", () => {
  it("tries once more, then answers STALE_GAME, never a server fault", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await finished([a, b]);
    const games = h.platform.repos.games;
    const real = games.createRematch.bind(games);
    let calls = 0;
    // As if every insert lost to a rematch that ended unplayed before this call could read it.
    games.createRematch = () => {
      calls += 1;
      return Promise.resolve(false);
    };
    const stale = await rematch(a, game.id);
    expect([stale.status, code(stale.body)]).toEqual([409, "STALE_GAME"]);
    expect(calls).toBe(2);
    // Losing once is retried: the second try creates it.
    calls = 0;
    games.createRematch = (...args) => {
      calls += 1;
      return calls === 1 ? Promise.resolve(false) : real(...args);
    };
    h.advance(MINUTE);
    const made = await rematch(a, game.id);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(calls).toBe(2);
    expect(linkOf(game.id)).toBe(made.body.game.id);
  });
});
