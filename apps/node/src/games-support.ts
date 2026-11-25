/**
 * Helpers for the game framework's integration tests: signed-in, onboarded players on the real
 * app (`test-harness.ts`), and typed calls of the game endpoints. Test-only; never part of the
 * build.
 */
import type { GameEnvelope } from "@your-move/sdk";
import { seededRandom } from "@your-move/testkit";
import { expect, onTestFailed } from "vitest";

import { installedGames } from "../../../generated/server-registry.js";
import { createHarness, type Harness, type HarnessOptions, PROD_ENV } from "./test-harness.js";

/** The seed of a test's games: `GAME_SEED` to replay a failure, otherwise a fresh one (an empty value counts as unset). */
export function gameSeed(): number {
  const given = process.env["GAME_SEED"];
  if (given === undefined || given === "")
    return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  const seed = Number(given);
  if (!/^\d+$/u.test(given) || !Number.isSafeInteger(seed)) {
    throw new Error(`GAME_SEED must be an integer, got ${JSON.stringify(given)}`);
  }
  return seed;
}

/**
 * A harness with the installed games, both enabled, playing from one seeded source (03 §4: only
 * tests seed). Call it in a test or `beforeEach`: a failure prints the seed, and `GAME_SEED=<seed>`
 * replays the same deals, seat orders and draws.
 */
export function gameHarness(
  env: Record<string, string> = {},
  options: Omit<HarnessOptions, "random"> = {},
): Harness {
  const seed = gameSeed();
  onTestFailed(() => {
    process.stderr.write(`game randomness seed: GAME_SEED=${String(seed)}\n`);
  });
  const source = seededRandom(seed);
  return createHarness(
    { ...PROD_ENV, ENABLED_GAMES: "words,example", ...env },
    { games: installedGames, ...options, random: () => source },
  );
}

export interface Player {
  readonly email: string;
  readonly cookie: string;
  readonly id: string;
  readonly name: string;
}

let counter = 0;

/** A new address, unique within the run. */
export function freshEmail(): string {
  counter += 1;
  return `player${String(counter)}-${crypto.randomUUID().slice(0, 8)}@example.org`;
}

/** Signs a new user in; with a name, completes onboarding too. */
export async function signUp(h: Harness, name: string | null = "Player"): Promise<Player> {
  const email = freshEmail();
  const cookie = await h.signIn(email);
  if (name !== null) {
    const response = await h.request("PATCH", "/api/v1/me", { displayName: name }, { cookie });
    expect(response.status).toBe(200);
  }
  const me = (await (await h.request("GET", "/api/v1/me", undefined, { cookie })).json()) as {
    id: string;
  };
  return { email, cookie, id: me.id, name: name ?? "" };
}

export interface GameResponse {
  readonly game: GameEnvelope;
  readonly view: unknown;
}

export interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly detail?: unknown };
}

/** A request's status and JSON body. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is the shape a test expects the body to have, unchecked
export async function call<T = unknown>(
  h: Harness,
  player: Player,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await h.request(method, path, body, { cookie: player.cookie });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as T };
}

/** Creates a game and returns its envelope; fails the test on anything but 201. */
export async function createGame(
  h: Harness,
  creator: Player,
  body: Record<string, unknown>,
): Promise<GameEnvelope> {
  const result = await call<{ game: GameEnvelope }>(h, creator, "POST", "/api/v1/games", body);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.game;
}

export async function getGame(h: Harness, player: Player, id: string): Promise<GameResponse> {
  const result = await call<GameResponse>(h, player, "GET", `/api/v1/games/${id}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

/** A lifecycle transition from the game's current version. */
export async function transition(
  h: Harness,
  player: Player,
  id: string,
  name: "start" | "accept" | "decline" | "resign" | "cancel",
  expectedVersion?: number,
) {
  const version = expectedVersion ?? (await getGame(h, player, id)).game.version;
  return call<GameResponse & ErrorBody>(h, player, "POST", `/api/v1/games/${id}/${name}`, {
    expectedVersion: version,
  });
}

/** Submits a move from the game's current version. */
export async function act(h: Harness, player: Player, id: string, action: unknown) {
  const { game } = await getGame(h, player, id);
  return call<GameResponse & ErrorBody & { record: unknown; describe: unknown }>(
    h,
    player,
    "POST",
    `/api/v1/games/${id}/actions`,
    { expectedVersion: game.version, action },
  );
}

/** The example game's view, as far as these tests read it. */
export interface ExampleView {
  readonly you: number | null;
  readonly seats: readonly { hand: number[] | null; status: string }[];
  readonly endReason: string | null;
}

/** Plays an example game to its end: every seat in `toAct` plays its first card. */
export async function playExampleToEnd(
  h: Harness,
  id: string,
  players: readonly Player[],
): Promise<void> {
  const byUser = new Map(players.map((player) => [player.id, player]));
  for (let step = 0; step < 500; step++) {
    const any = players[0];
    if (any === undefined) throw new Error("no players");
    const { game } = await getGame(h, any, id);
    if (game.status !== "active") return;
    const seat = game.toAct[0];
    const userId = game.players.find((row) => row.seat === seat)?.userId;
    const player = userId == null ? undefined : byUser.get(userId);
    if (seat === undefined || player === undefined) throw new Error("nobody to act");
    const { view } = await getGame(h, player, id);
    const card = (view as ExampleView).seats[seat]?.hand?.[0];
    const moved = await act(h, player, id, { card });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  }
  throw new Error("the example game didn't end");
}
