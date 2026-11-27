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
  it("through the creation path: the same setup, the caller first, the others added at once", async () => {
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
      // Every seat filled by past opponents added at once: it starts at creation.
      status: "active",
      yourSeat: 0,
    });
    // The caller first, then the others in their old seat order (02 §4 `join`).
    const oldOrder = game.players
      .filter((player) => player.userId !== c.id)
      .sort((x, y) => (x.seat ?? 0) - (y.seat ?? 0))
      .map((player) => player.userId);
    expect(made.players.map((player) => player.userId)).toEqual([c.id, ...oldOrder]);
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

  it("skips a player whose account was deleted, leaving their seat open", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await finished([a, b, c]);
    // The last step of account deletion (04): the row goes, its seats keep no user.
    h.exec("DELETE FROM sessions WHERE user_id = ?", c.id);
    h.exec("DELETE FROM users WHERE id = ?", c.id);
    const asked = await rematch(a, game.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body.game.status).toBe("lobby");
    expect(
      h.query(
        "SELECT user_id, state FROM game_players WHERE game_id = ? ORDER BY rowid",
        asked.body.game.id,
      ),
    ).toEqual([
      { user_id: a.id, state: "joined" },
      { user_id: b.id, state: "joined" },
    ]);
    expect(h.query("SELECT seats FROM games WHERE id = ?", asked.body.game.id)[0]?.["seats"]).toBe(
      3,
    );
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
    h.advance(DAY);
    const asked = await rematch(b, words.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body.game.options).toEqual(current);
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
    for (let round = 0; round < 5; round++) {
      const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
      const game = await finished([a, b]);
      const count = Number(gameCount());
      const answers = await Promise.all([rematch(a, game.id), rematch(b, game.id)]);
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
    // b's press lands while a's is between its checks and its insert.
    games.createRematch = async (...args) => {
      games.createRematch = real;
      winner = (await rematch(b, game.id)).body;
      return real(...args);
    };
    const count = Number(gameCount());
    const lost = await rematch(a, game.id);
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);
    expect(lost.body.game.id).toBe(winner?.game.id);
    expect(lost.body.game.players.find((player) => player.isCreator)?.userId).toBe(b.id);
    expect(Number(gameCount())).toBe(count + 1);
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

  it("refuses to accept an invitation in a lobby that has ended: WRONG_STATUS", async () => {
    const [a, b, c] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const game = await finished([a, b, c]);
    h.exec("UPDATE users SET settings = ? WHERE id = ?", '{"whoCanAddMe":"nobody"}', b.id);
    const made = (await rematch(a, game.id)).body.game;
    // Past its 14 days, the lobby expires when b comes back (lazy expiry).
    h.advance(15 * DAY);
    expect((await getGame(h, b, game.id)).game.rematch?.you).toBe("none");
    const asked = await rematch(b, game.id);
    expect([asked.status, code(asked.body)]).toEqual([409, "WRONG_STATUS"]);
    expect((await getGame(h, a, made.id)).game.status).toBe("expired");
  });
});
