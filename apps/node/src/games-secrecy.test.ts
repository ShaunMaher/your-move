/**
 * The route-wide secrecy test (docs/spec/04-data-model.md invariant 4, 08 T8): through whole games
 * of the hidden-hand reference game and of words, every response of every game route, to every
 * member, is checked against the secrets stored at that moment. No response may contain the
 * module state, the recorded randomness, a raw action, or another seat's final view, and no
 * response may carry a key naming one of those columns.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  call,
  createGame,
  type ExampleView,
  gameHarness,
  getGame,
  type Player,
  signUp,
} from "./games-support.js";
import type { Harness } from "./test-harness.js";

let h: Harness;
beforeEach(() => {
  h = gameHarness();
});
afterEach(() => {
  h.close();
});

/**
 * Keys that would mean a secret column was serialised. `state` is also a player row's state
 * (`"playing"`, …), which is public; any other value under it is not.
 */
const PLAYER_STATES = new Set([
  "invited",
  "joined",
  "declined",
  "left",
  "removed",
  "playing",
  "out",
]);
const FORBIDDEN_KEYS = new Set([
  "state",
  "setupRng",
  "setup_rng",
  "rng",
  "action",
  "finalViews",
  "final_views",
  "writeToken",
  "write_token",
  "inviteEmail",
]);

/** Every key in a JSON value that names a secret column. */
function forbiddenKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) forbiddenKeys(item, into);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      const playerState = key === "state" && typeof item === "string" && PLAYER_STATES.has(item);
      if (FORBIDDEN_KEYS.has(key) && !playerState) into.push(key);
      forbiddenKeys(item, into);
    }
  }
  return into;
}

/** The secrets of a game as stored now, each a string that must never appear in a response. */
function secretsOf(gameId: string, viewerSeat: number | null): string[] {
  const [game] = h.query("SELECT state, setup_rng, final_views FROM games WHERE id = ?", gameId);
  const secrets: string[] = [];
  for (const column of ["state", "setup_rng"]) {
    const value = game?.[column];
    if (typeof value === "string" && value !== "[]") secrets.push(value);
  }
  for (const row of h.query("SELECT action, rng FROM game_actions WHERE game_id = ?", gameId)) {
    for (const column of ["action", "rng"]) {
      const value = row[column];
      if (typeof value === "string" && value !== "[]") secrets.push(value);
    }
  }
  const stored = game?.["final_views"];
  if (typeof stored === "string") {
    const finalViews = JSON.parse(stored) as { seats: { view: unknown }[] };
    finalViews.seats.forEach((entry, seat) => {
      if (seat !== viewerSeat) secrets.push(JSON.stringify(entry.view));
    });
  }
  return secrets;
}

/** Checks one response body against the game's secrets for this viewer. */
function check(text: string, gameId: string, viewer: Player, label: string): void {
  if (text === "") return;
  const body: unknown = JSON.parse(text);
  expect(forbiddenKeys(body), label).toEqual([]);
  const [row] = h.query(
    "SELECT seat FROM game_players WHERE game_id = ? AND user_id = ?",
    gameId,
    viewer.id,
  );
  const seat = typeof row?.["seat"] === "number" ? row["seat"] : null;
  for (const secret of secretsOf(gameId, seat)) {
    expect(text.includes(secret), `${label}: contains a secret`).toBe(false);
  }
}

/** Every read route of the game for every player, each response checked. */
async function readEverything(gameId: string, players: readonly Player[]): Promise<number> {
  let responses = 0;
  for (const player of players) {
    for (const path of [
      `/api/v1/games/${gameId}`,
      `/api/v1/games/${gameId}/history`,
      "/api/v1/games",
      "/api/v1/games?invitations=true",
      "/api/v1/catalog",
    ]) {
      const response = await h.request("GET", path, undefined, { cookie: player.cookie });
      check(await response.text(), gameId, player, `GET ${path}`);
      responses += 1;
    }
  }
  return responses;
}

/** A transition or move, its response checked like any read. */
async function write(gameId: string, player: Player, path: string, body: unknown) {
  const response = await h.request("POST", path, body, { cookie: player.cookie });
  const text = await response.text();
  check(text, gameId, player, `POST ${path}`);
  return { status: response.status, text };
}

describe("route-wide secrecy (04 invariant 4)", () => {
  it("never serialises state, randomness, raw actions or another seat's final view: example", async () => {
    const players = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const [a, b, c] = players as [Player, Player, Player];
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      seatOrder: "random",
      options: { lives: 2 },
      invitees: [{ email: b.email }, { email: c.email }],
    });
    let responses = await readEverything(game.id, players);
    for (const who of [b, c]) {
      const version = (await getGame(h, who, game.id)).game.version;
      await write(game.id, who, `/api/v1/games/${game.id}/accept`, { expectedVersion: version });
      h.advance(1000);
    }
    for (let step = 0; step < 300; step++) {
      const { game: now } = await getGame(h, a, game.id);
      if (now.status !== "active") break;
      // Not vacuous: there is something secret to leak at every step.
      expect(secretsOf(game.id, null).length).toBeGreaterThan(0);
      responses += await readEverything(game.id, players);
      const seat = now.toAct[0];
      const userId = now.players.find((row) => row.seat === seat)?.userId;
      const player = players.find((p) => p.id === userId);
      if (seat === undefined || player === undefined) throw new Error("nobody to act");
      const { view } = await getGame(h, player, game.id);
      const card = (view as ExampleView).seats[seat]?.hand?.[0];
      await write(game.id, player, `/api/v1/games/${game.id}/preview`, { action: { card } });
      const moved = await write(game.id, player, `/api/v1/games/${game.id}/actions`, {
        expectedVersion: now.version,
        action: { card },
      });
      expect(moved.status, moved.text).toBe(200);
      responses += 2;
    }
    expect((await getGame(h, a, game.id)).game.status).toBe("finished");
    responses += await readEverything(game.id, players);
    expect(responses).toBeGreaterThan(100);
  });

  it("never serialises them in words either, through a resignation", async () => {
    const players = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const [a, b] = players as [Player, Player];
    const game = await createGame(h, a, { gameType: "words", invitees: [{ email: b.email }] });
    await readEverything(game.id, players);
    await write(game.id, b, `/api/v1/games/${game.id}/accept`, { expectedVersion: 0 });
    for (let turn = 0; turn < 4; turn++) {
      await readEverything(game.id, players);
      const { game: now } = await getGame(h, a, game.id);
      const player = now.toAct[0] === 0 ? a : b;
      const swapped = await write(game.id, player, `/api/v1/games/${game.id}/actions`, {
        expectedVersion: now.version,
        action: { type: "pass" },
      });
      expect(swapped.status, swapped.text).toBe(200);
    }
    const { game: now } = await getGame(h, a, game.id);
    await write(game.id, a, `/api/v1/games/${game.id}/resign`, { expectedVersion: now.version });
    expect((await getGame(h, b, game.id)).game.status).toBe("finished");
    await readEverything(game.id, players);
    // A member's own final view is theirs to see; only another seat's is a secret.
    const own = await call<{ view: unknown }>(h, b, "GET", `/api/v1/games/${game.id}`);
    expect(own.body.view).not.toBeNull();
  });
});
