/**
 * Integration tests of the game framework (docs/spec/02-game-framework.md §4–§5, 05 §Games): the
 * real app on a real SQLite database with the installed `words` and `example` packages, so no
 * game-specific code can hide in the framework (10 M3). One test per rule.
 */
import type { GameEnvelope } from "@your-move/sdk";
import { replayState } from "@your-move/server/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installedGames } from "../../../generated/server-registry.js";
import {
  act,
  call,
  createGame,
  type ErrorBody,
  type ExampleView,
  freshEmail,
  gameHarness,
  getGame,
  playExampleToEnd,
  type Player,
  signUp,
  transition,
} from "./games-support.js";
import { createHarness, DAY, type Harness, PROD_ENV } from "./test-harness.js";

let h: Harness;
beforeEach(() => {
  h = gameHarness();
});
afterEach(() => {
  h.close();
});

const code = (body: unknown): string | undefined => (body as Partial<ErrorBody>).error?.code;

/** Replaying the stored log reproduces the stored state exactly (04 invariant 1). */
async function expectReplays(gameId: string): Promise<void> {
  const repos = h.platform.repos;
  const game = await repos.games.get(gameId);
  const definition = installedGames.find((g) => g.manifest.type === game?.gameType)?.engines[1];
  if (game?.state == null || definition === undefined) throw new Error("no started game");
  expect(JSON.stringify(replayState(definition, game, await repos.games.actions(gameId)))).toBe(
    game.state,
  );
}

/** A two-player example game between `a` (creator, seat 0) and `b`, started by b's accept. */
async function startedExample(a: Player, b: Player, options: Record<string, unknown> = {}) {
  const created = await createGame(h, a, {
    gameType: "example",
    options,
    invitees: [{ email: b.email }],
  });
  const accepted = await transition(h, b, created.id, "accept");
  expect(accepted.status).toBe(200);
  expect(accepted.body.game.status).toBe("active");
  return accepted.body.game;
}

describe("GET /api/v1/catalog and the rules", () => {
  it("lists the enabled game types with their module catalog and defaults", async () => {
    const a = await signUp(h, "Ada");
    const { status, body } = await call<{
      games: { type: string; version: number; defaults: unknown; catalog: unknown }[];
    }>(h, a, "GET", "/api/v1/catalog");
    expect(status).toBe(200);
    expect(body.games.map((game) => game.type)).toEqual(["words", "example"]);
    const words = body.games[0];
    expect(words).toMatchObject({ version: 1, defaultTurnTimeoutDays: 14, defaults: {} });
    expect(JSON.stringify(words?.catalog)).toContain('"enable"');
    // Metadata only: never a word list's hash, size or contents (08 T22).
    expect(JSON.stringify(body)).not.toMatch(/sha256|wordsSha256|bytes|blob/u);
  });

  it("offers only ENABLED_GAMES: the example game is disabled by default", async () => {
    const plain = createHarness(PROD_ENV, {
      games: (await import("../../../generated/server-registry.js")).installedGames,
    });
    try {
      const a = await signUp(plain, "Ada");
      const catalog = await call<{ games: { type: string }[] }>(plain, a, "GET", "/api/v1/catalog");
      expect(catalog.body.games.map((game) => game.type)).toEqual(["words"]);
      const created = await call(plain, a, "POST", "/api/v1/games", {
        gameType: "example",
        invitees: [],
      });
      expect(created.status).toBe(400);
      expect(code(created.body)).toBe("UNKNOWN_GAME");
    } finally {
      plain.close();
    }
  });

  it("serves each game type's rules publicly, latest version by default", async () => {
    const response = await h.request("GET", "/api/v1/games/types/example/rules", undefined, {
      origin: null,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { type: string; version: number; markdown: string };
    expect(body).toMatchObject({ type: "example", version: 1 });
    expect(body.markdown).toMatch(/^# Example/u);
    for (const path of [
      "/api/v1/games/types/nope/rules",
      "/api/v1/games/types/example/rules?version=2",
    ]) {
      expect((await h.request("GET", path, undefined, { origin: null })).status).toBe(404);
    }
  });

  it("requires a session for everything but the rules", async () => {
    for (const [method, path] of [
      ["GET", "/api/v1/catalog"],
      ["GET", "/api/v1/games"],
      ["POST", "/api/v1/games"],
      ["GET", `/api/v1/games/${crypto.randomUUID()}`],
      ["POST", `/api/v1/games/${crypto.randomUUID()}/start`],
    ] as const) {
      const response = await h.request(method, path, method === "POST" ? {} : undefined);
      expect(response.status, path).toBe(401);
    }
  });
});

describe("POST /api/v1/games", () => {
  it("creates a lobby: the creator joined in seat order, the invitee invited", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await createGame(h, a, {
      gameType: "words",
      invitees: [{ email: b.email }],
    });
    expect(game).toMatchObject({
      gameType: "words",
      gameVersion: 1,
      status: "lobby",
      version: 0,
      turnTimeoutDays: 14,
      seatOrder: "join",
      aiAssistance: "off",
      available: true,
      yourSeat: null,
      toAct: [],
      yourTurn: false,
      yourInvitation: null,
      options: { rulesetId: "classic", rulesetVersion: 1, dictionaryId: "enable" },
    });
    expect(game.resources).toEqual([
      expect.objectContaining({ kind: "dictionary", id: "enable", distribution: "public" }),
    ]);
    expect(game.resources[0]?.downloadUrl).toMatch(
      /^\/assets\/dictionaries\/enable-v\d+\.[0-9a-f]{16}\.txt$/u,
    );
    expect(game.players).toEqual([
      expect.objectContaining({
        userId: a.id,
        displayName: "Ada",
        state: "joined",
        isCreator: true,
        isYou: true,
        seat: null,
      }),
      expect.objectContaining({
        userId: null,
        displayName: null,
        state: "invited",
        invitedAs: b.email,
        isCreator: false,
        isYou: false,
      }),
    ]);
  });

  it("gives an onboarded user, an unknown address and an un-onboarded account the same response (Q3)", async () => {
    const a = await signUp(h, "Ada");
    const known = await signUp(h, "Bo");
    const halfway = await signUp(h, null);
    const shapes = [];
    for (const email of [known.email, freshEmail(), halfway.email]) {
      const game = await createGame(h, a, { gameType: "words", invitees: [{ email }] });
      const invitee = game.players.find((player) => !player.isCreator);
      shapes.push({ ...invitee, invitedAs: invitee?.invitedAs === email, playerId: undefined });
    }
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
    // Only the onboarded user holds an invitation; the others are email-invite seats (06 §6.1).
    const rows = h.query(
      "SELECT user_id, invite_email, delivery FROM game_players WHERE state = 'invited' ORDER BY rowid",
    );
    expect(rows.map((row) => row["user_id"])).toEqual([known.id, null, null]);
    expect(rows.every((row) => row["delivery"] === "normal")).toBe(true);
  });

  it("invites an onboarded user whatever their whoCanAddMe: adding by email never auto-joins (06 §6.2)", async () => {
    const a = await signUp(h, "Ada");
    for (const setting of ["pastOpponents", "nobody"]) {
      const b = await signUp(h, "Bo");
      h.exec(
        "UPDATE users SET settings = ? WHERE id = ?",
        JSON.stringify({ whoCanAddMe: setting }),
        b.id,
      );
      const game = await createGame(h, a, { gameType: "words", invitees: [{ email: b.email }] });
      expect(game.status).toBe("lobby");
      const seen = await getGame(h, b, game.id);
      expect(seen.game.yourInvitation).toBe("normal");
      expect(seen.view).toBeNull();
    }
  });

  it.each<[string, Record<string, unknown>, number, string]>([
    ["an unknown game type", { gameType: "chess" }, 400, "UNKNOWN_GAME"],
    [
      "options the module refuses",
      { gameType: "words", options: { rulesetId: "nope" } },
      400,
      "INVALID_OPTIONS",
    ],
    [
      "an unknown dictionary",
      { gameType: "words", options: { dictionaryId: "u_x" } },
      400,
      "INVALID_OPTIONS",
    ],
    [
      "a seat count outside players(options)",
      { gameType: "words", seats: 3 },
      400,
      "INVALID_SEAT_COUNT",
    ],
    ["a fractional seat count", { gameType: "example", seats: 2.5 }, 400, "INVALID_SEAT_COUNT"],
    ["a timeout of 0 days", { gameType: "words", turnTimeoutDays: 0 }, 400, "INVALID_TIMEOUT"],
    ["a timeout of 31 days", { gameType: "words", turnTimeoutDays: 31 }, 400, "INVALID_TIMEOUT"],
    ["a fractional timeout", { gameType: "words", turnTimeoutDays: 1.5 }, 400, "INVALID_TIMEOUT"],
    [
      "validateStart refusing the seat count",
      { gameType: "example", seats: 4, options: { handSize: 6 } },
      409,
      "INVALID_SEATS",
    ],
  ])("refuses %s, creating nothing", async (_name, body, status, expected) => {
    const a = await signUp(h, "Ada");
    const result = await call(h, a, "POST", "/api/v1/games", { invitees: [], ...body });
    expect(result.status).toBe(status);
    expect(code(result.body)).toBe(expected);
    expect(h.query("SELECT count(*) AS n FROM games")[0]?.["n"]).toBe(0);
  });

  it("wraps the module's codes: INVALID_OPTIONS and INVALID_SEATS carry { code, detail }", async () => {
    const a = await signUp(h, "Ada");
    const options = await call<ErrorBody>(h, a, "POST", "/api/v1/games", {
      gameType: "example",
      options: { lives: 9 },
      invitees: [],
    });
    expect(options.body.error.detail).toEqual({
      code: "OPTION_OUT_OF_RANGE",
      detail: { option: "lives", min: 1, max: 3 },
    });
    const seats = await call<ErrorBody>(h, a, "POST", "/api/v1/games", {
      gameType: "example",
      seats: 4,
      options: { handSize: 6 },
      invitees: [],
    });
    expect(seats.body.error.detail).toEqual({
      code: "DECK_TOO_SMALL",
      detail: { needed: 24, deckSize: 20 },
    });
  });

  it.each<[string, (a: Player) => unknown[], string]>([
    [
      "more invitees than seats - 1",
      () => [{ email: freshEmail() }, { email: freshEmail() }],
      "INVALID_INVITEES",
    ],
    ["an invalid address", () => [{ email: "not an address" }], "INVALID_INVITEES"],
    [
      "a literal duplicate",
      () => {
        const e = freshEmail();
        return [{ email: e }, { email: e.toUpperCase() }];
      },
      "INVALID_INVITEES",
    ],
    [
      "the creator's own address",
      (a) => [{ email: ` ${a.email.toUpperCase()}` }],
      "CANNOT_PLAY_SELF",
    ],
  ])("refuses %s", async (_name, invitees, expected) => {
    const a = await signUp(h, "Ada");
    const result = await call(h, a, "POST", "/api/v1/games", {
      gameType: "example",
      seats: 2,
      invitees: invitees(a),
    });
    expect(result.status).toBe(400);
    expect(code(result.body)).toBe(expected);
  });

  it("refuses an account that hasn't finished onboarding", async () => {
    const halfway = await signUp(h, null);
    const result = await call(h, halfway, "POST", "/api/v1/games", {
      gameType: "words",
      invitees: [],
    });
    expect(result.status).toBe(403);
    expect(code(result.body)).toBe("ONBOARDING_REQUIRED");
    const list = await call(h, halfway, "GET", "/api/v1/games");
    expect(code(list.body)).toBe("ONBOARDING_REQUIRED");
  });

  it("remembers the options per game type and fills omitted keys from them (05 §Remembered options)", async () => {
    const a = await signUp(h, "Ada");
    await createGame(h, a, { gameType: "example", options: { handSize: 4 }, invitees: [] });
    const next = await createGame(h, a, {
      gameType: "example",
      options: { lives: 3 },
      invitees: [],
    });
    expect(next.options).toEqual({ handSize: 4, lives: 3 });
    const catalog = await call<{ games: { type: string; defaults: unknown }[] }>(
      h,
      a,
      "GET",
      "/api/v1/catalog",
    );
    expect(catalog.body.games.find((game) => game.type === "example")?.defaults).toEqual({
      handSize: 4,
      lives: 3,
    });
  });

  it("falls back to the request's input alone when the remembered options no longer resolve", async () => {
    const a = await signUp(h, "Ada");
    h.exec(
      "UPDATE users SET settings = ? WHERE id = ?",
      JSON.stringify({ lastOptions: { example: { handSize: 99 } } }),
      a.id,
    );
    const game = await createGame(h, a, {
      gameType: "example",
      options: { lives: 1 },
      invitees: [],
    });
    expect(game.options).toEqual({ handSize: 3, lives: 1 });
    const catalog = await call<{ games: { type: string; defaults: unknown }[] }>(
      h,
      a,
      "GET",
      "/api/v1/catalog",
    );
    expect(catalog.body.games.find((game) => game.type === "example")?.defaults).toEqual({
      lives: 1,
    });
  });

  it("caps the email invitees per user: over 5 an hour, the whole request is 429 and nothing is created", async () => {
    const a = await signUp(h, "Ada");
    for (let i = 0; i < 5; i++) {
      await createGame(h, a, { gameType: "words", invitees: [{ email: freshEmail() }] });
    }
    const over = await call(h, a, "POST", "/api/v1/games", {
      gameType: "words",
      invitees: [{ email: freshEmail() }],
    });
    expect(over.status).toBe(429);
    expect(h.query("SELECT count(*) AS n FROM games")[0]?.["n"]).toBe(5);
    // A game without email invitees still may be created.
    await createGame(h, a, { gameType: "words", invitees: [] });
  });

  it("caps live games per pair by the typed address's emailId (TOO_MANY_GAMES)", async () => {
    const a = await signUp(h, "Ada");
    const email = freshEmail();
    for (let i = 0; i < 5; i++) {
      await createGame(h, a, { gameType: "words", invitees: [{ email }] });
      h.advance(DAY);
    }
    const over = await call(h, a, "POST", "/api/v1/games", {
      gameType: "words",
      invitees: [{ email: email.toUpperCase() }],
    });
    expect(over.status).toBe(409);
    expect(code(over.body)).toBe("TOO_MANY_GAMES");
  });
});

describe("membership (04 §Membership)", () => {
  it("answers 404 to non-members on every game route, never 403", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const stranger = await signUp(h, "Cy");
    const game = await startedExample(a, b);
    for (const [method, path, body] of [
      ["GET", `/api/v1/games/${game.id}`, undefined],
      ["GET", `/api/v1/games/${game.id}/history`, undefined],
      [
        "POST",
        `/api/v1/games/${game.id}/actions`,
        { expectedVersion: game.version, action: { card: 1 } },
      ],
      ["POST", `/api/v1/games/${game.id}/preview`, { action: { card: 1 } }],
      ["POST", `/api/v1/games/${game.id}/resign`, { expectedVersion: game.version }],
      ["POST", `/api/v1/games/${game.id}/decline`, { expectedVersion: game.version }],
      ["POST", `/api/v1/games/${game.id}/seen`, { version: game.version }],
    ] as const) {
      const result = await call(h, stranger, method, path, body);
      expect(result.status, path).toBe(404);
      expect(code(result.body)).toBe("NOT_FOUND");
    }
    expect((await call(h, stranger, "GET", `/api/v1/games/${crypto.randomUUID()}`)).status).toBe(
      404,
    );
  });

  it("drops unfilled invitations at start: their holders lose access", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const c = await signUp(h, "Cy");
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }, { email: c.email }],
    });
    expect((await transition(h, b, game.id, "accept")).status).toBe(200);
    const started = await transition(h, a, game.id, "start");
    expect(started.status).toBe(200);
    expect(started.body.game.status).toBe("active");
    expect(started.body.game.players.map((player) => player.userId)).toEqual([a.id, b.id]);
    expect((await call(h, c, "GET", `/api/v1/games/${game.id}`)).status).toBe(404);
    const dropped = h.query(
      "SELECT state, seat, invite_email FROM game_players WHERE user_id = ?",
      c.id,
    );
    expect(dropped).toEqual([{ state: "dropped", seat: null, invite_email: null }]);
  });

  it("takes yourSeat from the viewer's own row, after seats are assigned at random", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await createGame(h, a, {
      gameType: "example",
      seatOrder: "random",
      invitees: [{ email: b.email }],
    });
    await transition(h, b, game.id, "accept");
    const forA = await getGame(h, a, game.id);
    const forB = await getGame(h, b, game.id);
    expect(new Set([forA.game.yourSeat, forB.game.yourSeat])).toEqual(new Set([0, 1]));
    expect((forA.view as ExampleView).you).toBe(forA.game.yourSeat);
    expect((forB.view as ExampleView).you).toBe(forB.game.yourSeat);
    expect(forA.game.players.find((player) => player.isYou)?.seat).toBe(forA.game.yourSeat);
    // The seat-order draw comes first in the recorded start draws.
    await expectReplays(game.id);
  });
});

describe("the lobby (02 §4)", () => {
  it("starts by itself when the last invitee accepts, seats in joining order", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await startedExample(a, b);
    expect(game.version).toBe(1);
    expect(game.players.map((player) => [player.seat, player.userId, player.state])).toEqual([
      [0, a.id, "playing"],
      [1, b.id, "playing"],
    ]);
    expect(game.toAct).toEqual([0, 1]);
    expect(
      game.players.every(
        (player) => player.deadline === (game.lastActionAt ?? 0) + game.turnTimeoutDays * DAY,
      ),
    ).toBe(true);
    // The start draws its randomness from the recorded source (02 §5).
    const [row] = h.query("SELECT setup_rng FROM games WHERE id = ?", game.id);
    const draws = JSON.parse(String(row?.["setup_rng"])) as [number, number][];
    expect(draws.length).toBeGreaterThan(0);
    expect(draws.every(([max, value]) => Number.isInteger(max) && value >= 0 && value < max)).toBe(
      true,
    );
  });

  it("doesn't start by itself when AI assistance is allowed with another person (02 §4, 08 T31)", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await createGame(h, a, {
      gameType: "example",
      aiAssistance: "allowed",
      invitees: [{ email: b.email }],
    });
    const accepted = await transition(h, b, game.id, "accept");
    expect(accepted.body.game).toMatchObject({ status: "lobby", aiAssistance: "allowed" });
    const started = await transition(h, a, game.id, "start");
    expect(started.body.game.status).toBe("active");
  });

  it("lets the creator start below the maximum, with at least min joined", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 4,
      invitees: [{ email: b.email }, { email: freshEmail() }],
    });
    const early = await transition(h, a, game.id, "start");
    expect(early.status).toBe(409);
    expect(code(early.body)).toBe("NOT_ENOUGH_PLAYERS");
    await transition(h, b, game.id, "accept");
    const notCreator = await transition(h, b, game.id, "start");
    expect(code(notCreator.body)).toBe("NOT_ALLOWED");
    const started = await transition(h, a, game.id, "start");
    expect(started.status).toBe(200);
    expect(started.body.game).toMatchObject({ status: "active", toAct: [0, 1] });
    expect(h.query("SELECT seats FROM games WHERE id = ?", game.id)[0]?.["seats"]).toBe(2);
    const again = await transition(h, a, game.id, "start");
    expect(code(again.body)).toBe("WRONG_STATUS");
  });

  it("refuses a stale expectedVersion with STALE_GAME", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await createGame(h, a, { gameType: "example", invitees: [{ email: b.email }] });
    const stale = await transition(h, b, game.id, "accept", game.version + 1);
    expect(stale.status).toBe(409);
    expect(code(stale.body)).toBe("STALE_GAME");
  });

  it("ends the lobby declined when a decline leaves too few to fill it", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await createGame(h, a, { gameType: "words", invitees: [{ email: b.email }] });
    const declined = await transition(h, b, game.id, "decline");
    // The decliner is no longer a member: nothing to show them.
    expect(declined.status).toBe(204);
    expect((await call(h, b, "GET", `/api/v1/games/${game.id}`)).status).toBe(404);
    const forA = await getGame(h, a, game.id);
    expect(forA.game).toMatchObject({ status: "declined", endReason: "declined" });
    // A row never joined shows only its state, to the creator too, once declined (05).
    expect(forA.game.players[1]).toEqual(
      expect.objectContaining({ state: "declined", userId: null, displayName: null }),
    );
    expect(forA.game.players[1]?.invitedAs).toBeUndefined();
    expect(forA.view).toBeNull();
    expect(h.query("SELECT invite_email FROM game_players WHERE game_id = ?", game.id)).toEqual([
      { invite_email: null },
      { invite_email: null },
    ]);
  });

  it("keeps the lobby open when a decline leaves enough joined and invited players", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const c = await signUp(h, "Cy");
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }, { email: c.email }],
    });
    await transition(h, b, game.id, "decline");
    expect((await getGame(h, a, game.id)).game.status).toBe("lobby");
    await transition(h, c, game.id, "accept");
    expect((await transition(h, a, game.id, "start")).body.game.status).toBe("active");
  });

  it("refuses the creator's decline in the lobby: cancel instead", async () => {
    const a = await signUp(h, "Ada");
    const game = await createGame(h, a, { gameType: "words", invitees: [{ email: freshEmail() }] });
    const declined = await transition(h, a, game.id, "decline");
    expect(declined.status).toBe(403);
    expect(code(declined.body)).toBe("NOT_ALLOWED");
  });

  it("lets only the creator cancel, only in the lobby", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await createGame(h, a, { gameType: "words", invitees: [{ email: b.email }] });
    expect(code((await transition(h, b, game.id, "cancel")).body)).toBe("NOT_ALLOWED");
    const cancelled = await transition(h, a, game.id, "cancel");
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.game).toMatchObject({ status: "cancelled", endReason: "cancelled" });
    expect(code((await transition(h, b, game.id, "accept")).body)).toBe("WRONG_STATUS");
    expect(code((await transition(h, a, game.id, "cancel")).body)).toBe("WRONG_STATUS");
  });

  it("refuses accept from someone who holds no invitation", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await startedExample(a, b);
    expect(code((await transition(h, a, game.id, "accept")).body)).toBe("WRONG_STATUS");
  });
});

describe("playing (02 §2.3, 05 /actions)", () => {
  it("checks in order: seat, active, version, turn, schema, then the module", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const lobby = await createGame(h, a, { gameType: "example", invitees: [{ email: b.email }] });
    // Nobody holds a seat in the lobby: check 1 answers first.
    const inLobby = await call(h, a, "POST", `/api/v1/games/${lobby.id}/actions`, {
      expectedVersion: 0,
      action: { card: 1 },
    });
    expect(code(inLobby.body)).toBe("NOT_FOUND");

    const game = await startedExample(a, b);
    const post = (player: Player, body: unknown) =>
      call(h, player, "POST", `/api/v1/games/${game.id}/actions`, body);
    expect(code((await post(a, { expectedVersion: 0, action: { card: 0 } })).body)).toBe(
      "STALE_GAME",
    );
    expect(code((await post(a, { expectedVersion: game.version, action: { card: 0 } })).body)).toBe(
      "INVALID_ACTION",
    );
    const { view } = await getGame(h, a, game.id);
    const hand = (view as ExampleView).seats[0]?.hand ?? [];
    const notInHand = [...Array(20).keys()].map((n) => n + 1).find((n) => !hand.includes(n));
    const illegal = await post(a, { expectedVersion: game.version, action: { card: notInHand } });
    expect(illegal.status).toBe(400);
    expect(code(illegal.body)).toBe("NOT_IN_HAND");

    const played = await post(a, { expectedVersion: game.version, action: { card: hand[0] } });
    expect(played.status).toBe(200);
    const body = played.body as { game: GameEnvelope; describe: unknown; record: unknown };
    expect(body.game.version).toBe(game.version + 1);
    expect(body.game.toAct).toEqual([1]);
    expect(body.describe).toEqual([{ seat: 0 }, " played a card in round 1"]);
    expect(body.record).toEqual({ kind: "played", seat: 0, round: 1 });
    const twice = await post(a, { expectedVersion: body.game.version, action: { card: hand[1] } });
    expect(code(twice.body)).toBe("NOT_YOUR_TURN");
  });

  it("keeps the clocks per seat: a seat that stays in toAct without acting keeps its clock", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await startedExample(a, b);
    const startedAt = game.lastActionAt ?? 0;
    h.advance(DAY);
    const { view } = await getGame(h, a, game.id);
    await act(h, a, game.id, { card: (view as ExampleView).seats[0]?.hand?.[0] });
    const after = await getGame(h, b, game.id);
    expect(after.game.players[1]?.deadline).toBe(startedAt + game.turnTimeoutDays * DAY);
    expect(after.game.players[0]?.deadline).toBeUndefined();
  });

  it("previews a move without committing it, from the seat's own information", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await startedExample(a, b);
    const { view } = await getGame(h, a, game.id);
    const hand = (view as ExampleView).seats[0]?.hand ?? [];
    const preview = await call(h, a, "POST", `/api/v1/games/${game.id}/preview`, {
      action: { card: hand[0] },
    });
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({ preview: { handAfter: hand.slice(1) } });
    expect((await getGame(h, a, game.id)).game.version).toBe(game.version);
    const bad = await call(h, a, "POST", `/api/v1/games/${game.id}/preview`, { action: { x: 1 } });
    expect(code(bad.body)).toBe("INVALID_ACTION");
  });

  it("plays a full words game by passing: finished, ranked, final views and past opponents", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const created = await createGame(h, a, { gameType: "words", invitees: [{ email: b.email }] });
    await transition(h, b, created.id, "accept");
    const bySeat = [a, b];
    for (let turn = 0; turn < 20; turn++) {
      const { game } = await getGame(h, a, created.id);
      if (game.status !== "active") break;
      const seat = game.toAct[0] ?? 0;
      const player = bySeat[seat];
      if (player === undefined) throw new Error("no player");
      const moved = await act(h, player, created.id, { type: "pass" });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    }
    const { game, view } = await getGame(h, b, created.id);
    expect(game.status).toBe("finished");
    expect(game.endReason).not.toBeNull();
    expect(game.toAct).toEqual([]);
    const ranks = game.players.map((player) => player.rank);
    expect(ranks).toContain(1);
    expect(ranks.every((rank) => rank === 1 || rank === 2)).toBe(true);
    expect(view).not.toBeNull();
    const pairs = h.query("SELECT user_id, other_id FROM past_opponents ORDER BY user_id");
    expect(pairs).toEqual(
      [
        { user_id: a.id, other_id: b.id },
        { user_id: b.id, other_id: a.id },
      ].sort((x, y) => (x.user_id < y.user_id ? -1 : 1)),
    );
    // Only seats' own final views and the public one are stored; a member gets their own.
    const [stored] = h.query("SELECT final_views FROM games WHERE id = ?", created.id);
    const finalViews = JSON.parse(String(stored?.["final_views"])) as { seats: unknown[] };
    expect(finalViews.seats).toHaveLength(2);
    expect(view).toEqual((finalViews.seats[1] as { view: unknown }).view);
    const moved = await act(h, a, created.id, { type: "pass" });
    expect(code(moved.body)).toBe("GAME_NOT_ACTIVE");
    await expectReplays(created.id);
  });

  it("plays a three-player example game to its end, ranking every seat", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const c = await signUp(h, "Cy");
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      options: { lives: 1 },
      invitees: [{ email: b.email }, { email: c.email }],
    });
    await transition(h, b, game.id, "accept");
    h.advance(1000);
    await transition(h, c, game.id, "accept");
    await playExampleToEnd(h, game.id, [a, b, c]);
    const finished = await getGame(h, a, game.id);
    expect(finished.game.status).toBe("finished");
    const ranks = finished.game.players.map((player) => player.rank ?? 0);
    expect(Math.min(...ranks)).toBe(1);
    // Elimination is shown as out (02 §4).
    expect(
      finished.game.players.some(
        (player) => player.state === "out" && player.outReason === "eliminated",
      ),
    ).toBe(true);
    expect((finished.view as ExampleView).endReason).not.toBeNull();
    await expectReplays(game.id);
  });
});

describe("leaving a started game (02 §4)", () => {
  it("a decline before a first action with too few left ends the game declined: no module call, no ranks, final views", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await startedExample(a, b);
    const declined = await transition(h, b, game.id, "decline");
    expect(declined.status).toBe(200);
    expect(declined.body.game).toMatchObject({
      status: "declined",
      endReason: "declined",
      toAct: [],
    });
    expect(
      declined.body.game.players.map((player) => [player.state, player.outReason, player.rank]),
    ).toEqual([
      ["playing", undefined, undefined],
      ["out", "declined", undefined],
    ]);
    // Framework-only: nothing logged, the state frozen as it was.
    expect(
      h.query("SELECT count(*) AS n FROM game_actions WHERE game_id = ?", game.id)[0]?.["n"],
    ).toBe(0);
    expect(declined.body.view).toMatchObject({ you: 1, endReason: null });
    const history = await call<{ items: unknown[] }>(
      h,
      a,
      "GET",
      `/api/v1/games/${game.id}/history`,
    );
    expect(history.body.items).toEqual([]);
  });

  it("the creator may decline too before acting", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await startedExample(a, b);
    const declined = await transition(h, a, game.id, "decline");
    expect(declined.body.game.status).toBe("declined");
  });

  it("a decline before a first action with enough left continues: logged as decline, says declined, never ranked", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const c = await signUp(h, "Cy");
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      options: { lives: 1 },
      invitees: [{ email: b.email }, { email: c.email }],
    });
    await transition(h, b, game.id, "accept");
    h.advance(1000);
    await transition(h, c, game.id, "accept");
    const declined = await transition(h, c, game.id, "decline");
    expect(declined.body.game.status).toBe("active");
    const history = await call<{ items: { kind: string; describe: unknown; seat: number }[] }>(
      h,
      a,
      "GET",
      `/api/v1/games/${game.id}/history`,
    );
    expect(history.body.items).toEqual([
      expect.objectContaining({
        seq: 1,
        seat: 2,
        kind: "decline",
        describe: [{ seat: 2 }, " declined the game"],
        via: "app",
      }),
    ]);
    expect(JSON.stringify(history.body)).not.toContain("resign");
    await playExampleToEnd(h, game.id, [a, b]);
    const finished = await getGame(h, a, game.id);
    expect(finished.game.status).toBe("finished");
    const decliner = finished.game.players[2];
    expect(decliner).toMatchObject({ state: "out", outReason: "declined" });
    expect(decliner?.rank).toBeUndefined();
    expect(
      finished.game.players
        .slice(0, 2)
        .map((player) => player.rank)
        .sort(),
    ).toEqual(expect.arrayContaining([1]));
    // Past opponents only between players who both acted.
    const pairs = h.query("SELECT user_id, other_id FROM past_opponents");
    expect(pairs.some((row) => row["user_id"] === c.id || row["other_id"] === c.id)).toBe(false);
  });

  it("refuses a decline after the seat's first action: ALREADY_ACTED", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await startedExample(a, b, { lives: 3 });
    const { view } = await getGame(h, a, game.id);
    await act(h, a, game.id, { card: (view as ExampleView).seats[0]?.hand?.[0] });
    const declined = await transition(h, a, game.id, "decline");
    expect(declined.status).toBe(409);
    expect(code(declined.body)).toBe("ALREADY_ACTED");
  });

  it("a resignation is a loss: the module decides, the record says resigned", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const created = await createGame(h, a, { gameType: "words", invitees: [{ email: b.email }] });
    await transition(h, b, created.id, "accept");
    const resigned = await transition(h, b, created.id, "resign");
    expect(resigned.status).toBe(200);
    expect(resigned.body.game.status).toBe("finished");
    expect(resigned.body.game.players.map((player) => [player.rank, player.outReason])).toEqual([
      [1, undefined],
      [2, "resigned"],
    ]);
    const history = await call<{ items: { kind: string }[] }>(
      h,
      a,
      "GET",
      `/api/v1/games/${created.id}/history`,
    );
    expect(history.body.items.map((item) => item.kind)).toEqual(["resign"]);
    expect(code((await transition(h, a, created.id, "resign")).body)).toBe("WRONG_STATUS");
  });
});

describe("GET /api/v1/games", () => {
  it("lists invitations, turns and summaries, newest activity first", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const first = await createGame(h, a, { gameType: "words", invitees: [{ email: b.email }] });
    h.advance(1000);
    const second = await startedExample(a, b);
    const list = await call<{
      games: {
        id: string;
        yourTurn: boolean;
        yourInvitation: string | null;
        summary: { headline: unknown[] };
        unread: boolean;
      }[];
      nextCursor: string | null;
    }>(h, b, "GET", "/api/v1/games");
    expect(list.status).toBe(200);
    expect(list.body.games.map((game) => game.id)).toEqual([second.id, first.id]);
    expect(list.body.games[0]).toMatchObject({
      yourTurn: true,
      yourInvitation: null,
      unread: true,
    });
    expect(list.body.games[1]).toMatchObject({ yourTurn: false, yourInvitation: "normal" });
    expect(list.body.games[1]?.summary.headline).toEqual(["Waiting for 1 player"]);
    expect(list.body.nextCursor).toBeNull();
    const invitations = await call<{ games: { id: string }[] }>(
      h,
      b,
      "GET",
      "/api/v1/games?invitations=true",
    );
    expect(invitations.body.games.map((game) => game.id)).toEqual([first.id]);
    const seen = await call(h, b, "POST", `/api/v1/games/${second.id}/seen`, {
      version: second.version,
    });
    expect(seen.status).toBe(204);
    const after = await call<{ games: { id: string; unread: boolean }[] }>(
      h,
      b,
      "GET",
      "/api/v1/games",
    );
    expect(after.body.games.find((game) => game.id === second.id)?.unread).toBe(false);
  });

  it("pages with a cursor, 50 at a time", async () => {
    const a = await signUp(h, "Ada");
    for (let i = 0; i < 52; i++) {
      h.exec(
        "INSERT INTO games (id, game_type, game_version, options, status, created_by, seats, turn_timeout_days, seat_order, ai_assistance, last_action_at, created_at, updated_at) VALUES (?, 'words', 1, '{}', 'lobby', ?, 2, 14, 'join', 'off', ?, 0, 0)",
        crypto.randomUUID(),
        a.id,
        i,
      );
    }
    h.exec(
      "INSERT INTO game_players (id, game_id, user_id, state, joined_via, joined_at) SELECT lower(hex(randomblob(16))), id, ?, 'joined', 'creator', 0 FROM games",
      a.id,
    );
    const first = await call<{ games: unknown[]; nextCursor: string | null }>(
      h,
      a,
      "GET",
      "/api/v1/games",
    );
    expect(first.body.games).toHaveLength(50);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await call<{ games: unknown[]; nextCursor: string | null }>(
      h,
      a,
      "GET",
      `/api/v1/games?cursor=${encodeURIComponent(first.body.nextCursor ?? "")}`,
    );
    expect(second.body.games).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
    expect((await call(h, a, "GET", "/api/v1/games?cursor=nope")).status).toBe(400);
  });

  it("keeps finished games 90 days and other endings 7 days", async () => {
    const a = await signUp(h, "Ada");
    const cancelled = await createGame(h, a, { gameType: "words", invitees: [] });
    await transition(h, a, cancelled.id, "cancel");
    const ids = async () =>
      (await call<{ games: { id: string }[] }>(h, a, "GET", "/api/v1/games")).body.games.map(
        (game) => game.id,
      );
    expect(await ids()).toContain(cancelled.id);
    h.advance(8 * DAY);
    expect(await ids()).not.toContain(cancelled.id);
  });
});

describe("orphaned games (02 §7.3)", () => {
  it("shows a game of an uninstalled rules version as unavailable and refuses every write", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await startedExample(a, b);
    h.exec("UPDATE games SET game_version = 99 WHERE id = ?", game.id);
    const seen = await getGame(h, a, game.id);
    expect(seen.game.available).toBe(false);
    expect(seen.view).toBeNull();
    const moved = await call(h, a, "POST", `/api/v1/games/${game.id}/actions`, {
      expectedVersion: game.version,
      action: { card: 1 },
    });
    expect(code(moved.body)).toBe("GAME_UNAVAILABLE");
    expect(code((await transition(h, a, game.id, "resign")).body)).toBe("GAME_UNAVAILABLE");
  });
});
