/**
 * Tests from the review of alpha slice A2 (docs/reviews/alpha-a2.md), each named by its finding:
 * the real app on a real SQLite database with the installed games, like `games.test.ts`.
 */
import type { AnyGameDefinition } from "@your-move/sdk";
import type { InstalledGame } from "@your-move/server";
import { seededRandom } from "@your-move/testkit";
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
import { createHarness, type Harness, PROD_ENV } from "./test-harness.js";

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

function installed(type: string): InstalledGame {
  const game = installedGames.find((candidate) => candidate.manifest.type === type);
  if (game === undefined) throw new Error(`${type} isn't installed`);
  return game;
}

/** The installed games with some of the example game's version 1 members replaced. */
function exampleWith(overrides: Partial<AnyGameDefinition>): InstalledGame[] {
  const example = installed("example");
  const engine = example.engines[1];
  if (engine === undefined) throw new Error("no example engine");
  return [installed("words"), { ...example, engines: { 1: { ...engine, ...overrides } } }];
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
    const h = harness({}, { games: throwing });
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

describe("P-5: the games' randomness is injected", () => {
  it("plays the same deal from the same seed, and another from another", async () => {
    const deal = async (seed: number) => {
      const h = createHarness(
        { ...PROD_ENV, ENABLED_GAMES: "words,example" },
        { games: installedGames, random: () => source },
      );
      const source = seededRandom(seed);
      open.push(h);
      const a = await signUp(h, "Ada");
      const b = await signUp(h, "Bo");
      const game = await startedExample(h, a, b);
      return h.query("SELECT state, setup_rng FROM games WHERE id = ?", game.id)[0];
    };
    const first = await deal(7);
    expect(await deal(7)).toEqual(first);
    expect(await deal(8)).not.toEqual(first);
  });
});

describe("S-3: creating a game changes only the remembered options in users.settings", () => {
  it("keeps a setting changed while the game was being created", async () => {
    const hook: { during?: () => void } = {};
    const h = harness(
      {},
      {
        wrapRepos: (repos) => ({
          ...repos,
          games: {
            ...repos.games,
            async create(...args) {
              await repos.games.create(...args);
              hook.during?.();
            },
          },
        }),
      },
    );
    const a = await signUp(h, "Ada");
    // Another request changes a setting after this one loaded the session's copy of the user.
    hook.during = () => {
      h.exec(
        "UPDATE users SET settings = json_set(settings, '$.whoCanAddMe', 'nobody') WHERE id = ?",
        a.id,
      );
    };
    await createGame(h, a, { gameType: "example", options: { lives: 2 }, invitees: [] });
    const [row] = h.query("SELECT settings FROM users WHERE id = ?", a.id);
    expect(JSON.parse(String(row?.["settings"]))).toEqual({
      whoCanAddMe: "nobody",
      lastOptions: { example: { lives: 2 } },
      lastGameType: "example",
    });
  });
});
