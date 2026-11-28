/**
 * The generic test kit (02 §6) on the pairs engine, and kit coverage (pairs §10): what the kit's
 * own fast-mode games, with its own seeds, reach. One kit run does both: the engine is wrapped so
 * every state the kit hands it can be traced back to the game it came from, without changing any
 * answer the engine gives.
 *
 * How a state is traced: a state is known by its JSON; a game starts at a `setup` result not seen
 * before; and a game's ending is the first finished state reached along its line of play. That
 * last rule rests on the order in which the kit works (packages/testkit/src/kit.ts, `Kit.game`): in
 * fast mode `plan.everyStep` is false, so a game's secrecy checks, the only transitions that branch
 * off it, run on its reservoir samples after the game has ended and been replayed (the
 * `for (const sample of reservoir)` line after `this.replay`). A change there would need this
 * tracing to change too.
 */
import type { GameEngines } from "@your-move/sdk";
import { runKit, type KitReport } from "@your-move/testkit";
import { threadCpuClock } from "@your-move/testkit/cpu-clock";
import { beforeAll, describe, expect, it } from "vitest";

import { engines } from "./engine/index.js";
import { hiddenCards } from "./engine/kit-hooks.js";
import { GRIDS, type EndReason, type GridId } from "./engine/schemas.js";
import type { State } from "./engine/state.js";
import { manifest } from "./manifest.js";

/** One game the kit played. */
interface Played {
  readonly grid: GridId;
  readonly seats: number;
  ending: { readonly reason: EndReason; readonly anyoneLeft: boolean } | null;
}

/** The hidden-card count of each distinct in-progress state the kit sampled for secrecy, by grid. */
type Samples = Map<GridId, Map<string, number>>;

/** Wraps rules version 1 so that it records what the kit plays, without changing any answer. */
function traced(): { engines: GameEngines; games: Played[]; samples: Samples } {
  const def = engines[1];
  const games: Played[] = [];
  const samples: Samples = new Map(GRIDS.map((grid) => [grid.id, new Map<string, number>()]));
  /** Each state seen, by its JSON: the game it belongs to, and whether a seat left on the way. */
  const lines = new Map<string, { game: Played; anyoneLeft: boolean }>();
  /** Follows a transition from `state` to `next`, if `state` is on a known line of play. */
  const trace = (state: State, next: State, leaves: boolean): void => {
    const from = lines.get(JSON.stringify(state));
    if (from === undefined) return;
    const anyoneLeft = from.anyoneLeft || leaves;
    const key = JSON.stringify(next);
    if (!lines.has(key)) lines.set(key, { game: from.game, anyoneLeft });
    if (next.endReason !== null && from.game.ending === null) {
      from.game.ending = { reason: next.endReason, anyoneLeft };
    }
  };
  const wrapped: typeof def = {
    ...def,
    setup(ctx) {
      const state = def.setup(ctx);
      const key = JSON.stringify(state);
      if (!lines.has(key)) {
        const game: Played = { grid: state.options.grid, seats: state.out.length, ending: null };
        games.push(game);
        lines.set(key, { game, anyoneLeft: false });
      }
      return state;
    },
    apply(state, seat, action, rng) {
      const next = def.apply(state, seat, action, rng);
      trace(state, next.state, false);
      return next;
    },
    onResign(state, seat, rng, reason) {
      const next = def.onResign(state, seat, rng, reason);
      trace(state, next.state, true);
      return next;
    },
    onTimeout(state, seat, rng) {
      const next = def.onTimeout(state, seat, rng);
      trace(state, next.state, true);
      return next;
    },
    test: {
      ...def.test,
      perturbHidden(state, viewer, rng) {
        if (state.endReason === null) {
          samples.get(state.options.grid)?.set(JSON.stringify(state), hiddenCards(state).length);
        }
        return def.test.perturbHidden(state, viewer, rng);
      },
    },
  };
  return { engines: { 1: wrapped }, games, samples };
}

// A measured budget (ADR 0004), not Vitest's 5 s default: the fast run plays its 300 games, every
// seat count from 2 to 6 on each grid, in about 24 s alone and about 71 s within `pnpm test` with
// coverage on a 16-thread developer machine (2026-11-29). The shared qemu64 CI runner ran the
// paths kit test about 2.3× slower than this machine, so 600 s leaves a wide margin.
const TIMEOUT_MS = 600_000;

describe("the generic test kit (02 §6) and its coverage (pairs §10)", () => {
  const { engines: wrapped, games, samples } = traced();
  let report: KitReport = { failures: [], games: 0 };
  beforeAll(() => {
    // The grids played come from the engine's own `test.optionInputs` hook, and every seat count
    // `players` allows. The CPU budget is timed in this thread's CPU time (02 §6.6). It is timed
    // through the tracing wrapper, which only adds to each call's cost (a few microseconds of
    // JSON against the 5 ms budget), so passing here is at least as strong as passing unwrapped.
    report = runKit(wrapped, { mode: "fast", manifest, cpuClock: threadCpuClock().now });
  }, TIMEOUT_MS);

  it("passes the pairs engine at every seat count from 2 to 6, on every grid", () => {
    expect(report.failures).toEqual([]);
    expect(report.games).toBeGreaterThanOrEqual(300);
    expect(games.filter((game) => game.ending !== null).length).toBeGreaterThanOrEqual(300);
  });

  it.for(GRIDS.map((grid) => grid.id))(
    "ends at least 90 % of the games with no seat leaving all-found on %s",
    (grid, { annotate }) => {
      const played = games.filter(
        (game) => game.grid === grid && game.ending?.anyoneLeft === false,
      );
      const allFound = played.filter((game) => game.ending?.reason === "all-found");
      const bySeats = [2, 3, 4, 5, 6].map((seats) => {
        const at = played.filter((game) => game.seats === seats);
        const found = at.filter((game) => game.ending?.reason === "all-found").length;
        return `${String(seats)} seats ${String(found)}/${String(at.length)}`;
      });
      void annotate(
        `${grid}: all-found in ${String(allFound.length)} of ${String(played.length)} (${bySeats.join(", ")})`,
      );
      expect(played.length).toBeGreaterThanOrEqual(30);
      expect(allFound.length / played.length).toBeGreaterThanOrEqual(0.9);
    },
  );

  it.for(GRIDS.map((grid) => grid.id))(
    "samples in-progress states with at most 4 hidden cards on %s",
    (grid, { annotate }) => {
      const counts = [...(samples.get(grid)?.values() ?? [])];
      const late = counts.filter((hidden) => hidden <= 4).length;
      void annotate(
        `${grid}: ${String(late)} of ${String(counts.length)} sampled states have at most 4 hidden cards (fewest ${String(Math.min(...counts))})`,
      );
      expect(late).toBeGreaterThanOrEqual(1);
    },
  );
});
