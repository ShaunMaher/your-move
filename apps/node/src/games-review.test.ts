/**
 * Tests from the review of alpha slice A2 (docs/reviews/alpha-a2.md), each named by its finding:
 * the real app on a real SQLite database with the installed games, like `games.test.ts`.
 */
import type { AnyGameDefinition } from "@your-move/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { installedGames } from "../../../generated/server-registry.js";
import {
  act,
  createGame,
  gameHarness,
  getGame,
  type Player,
  signUp,
  transition,
} from "./games-support.js";
import type { Harness } from "./test-harness.js";

const open: Harness[] = [];
afterEach(() => {
  for (const harness of open.splice(0)) harness.close();
});

/** A harness closed after the test. */
function harness(...args: Parameters<typeof gameHarness>): Harness {
  const h = gameHarness(...args);
  open.push(h);
  return h;
}

const example = installedGames.find((game) => game.manifest.type === "example");
const words = installedGames.find((game) => game.manifest.type === "words");
if (example === undefined || words === undefined) throw new Error("the games aren't installed");

/** The example game with some of its version 1 members replaced. */
function exampleWith(overrides: Partial<AnyGameDefinition>) {
  const engine = example?.engines[1];
  if (engine === undefined) throw new Error("no example engine");
  return { ...example, engines: { 1: { ...engine, ...overrides } as AnyGameDefinition } };
}

/** A two-player example game between `a` and `b`, started by b's accept. */
async function startedExample(h: Harness, a: Player, b: Player) {
  const created = await createGame(h, a, { gameType: "example", invitees: [{ email: b.email }] });
  const accepted = await transition(h, b, created.id, "accept");
  expect(accepted.status).toBe(200);
  return accepted.body.game;
}

describe("S-5: a module's exception never reaches the log with its message", () => {
  it("logs the game type, the member, the original's class and its frames, and answers 500", async () => {
    const throwing = exampleWith({
      apply: () => {
        throw new Error("the hidden hand is 7,8,9 secret-xyz");
      },
    });
    const h = harness({}, { games: [words, throwing].filter((game) => game !== undefined) });
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await startedExample(h, a, b);
    const seat = game.toAct[0];
    const player = game.players.find((row) => row.seat === seat)?.userId === a.id ? a : b;
    const { view } = await getGame(h, player, game.id);
    const card = (view as { seats: { hand: number[] | null }[] }).seats[seat ?? 0]?.hand?.[0];
    const moved = await act(h, player, game.id, { card });
    expect(moved.status).toBe(500);
    const fault = h.logs.find((entry) => entry["msg"] === "unhandled error");
    expect(fault).toMatchObject({
      errorClass: "EngineFault",
      gameType: "example",
      member: "apply",
      causeClass: "Error",
    });
    expect(String(fault?.["stack"])).toMatch(/^\s+at /u);
    expect(JSON.stringify(h.logs)).not.toContain("secret-xyz");
    expect(JSON.stringify(moved.body)).not.toContain("secret-xyz");
  });
});
