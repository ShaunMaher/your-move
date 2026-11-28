/**
 * Kit coverage (pairs §10): what the generic kit's own fast-mode games, with its own seeds, reach.
 * The engine is wrapped so every state the kit hands it can be traced back to the game it came
 * from: a state is known by its JSON, a game starts at a `setup` result not seen before, and a
 * game's ending is the first finished state reached along its line of play. (The kit's secrecy
 * checks branch off a game only after it has ended, so their transitions never come first.)
 */
import type { GameEngines } from "@your-move/sdk";
import { runKit } from "@your-move/testkit";
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

/** What the wrapped engine saw. */
interface Seen {
  readonly games: Played[];
  /** By grid: the fewest hidden cards in any secrecy sample taken in progress. */
  readonly fewestHidden: Map<GridId, number>;
}

/** Wraps rules version 1 so that it records what the kit plays, without changing any answer. */
function traced(): { engines: GameEngines; seen: Seen } {
  const def = engines[1];
  const seen: Seen = { games: [], fewestHidden: new Map() };
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
        seen.games.push(game);
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
          const grid = state.options.grid;
          const hidden = hiddenCards(state).length;
          seen.fewestHidden.set(grid, Math.min(hidden, seen.fewestHidden.get(grid) ?? hidden));
        }
        return def.test.perturbHidden(state, viewer, rng);
      },
    },
  };
  return { engines: { 1: wrapped }, seen };
}

// A measured budget (ADR 0004): one fast kit run, as kit.test.ts, plus the tracing (about 10 s
// alone on a 16-thread developer machine, 2026-11-29); 600 s for the slow CI runner.
describe("kit coverage (pairs §10)", { timeout: 600_000 }, () => {
  const { engines: wrapped, seen } = traced();
  let report: ReturnType<typeof runKit> = { failures: [], games: 0 };
  beforeAll(() => {
    // The kit's fast mode with its own seeds. The CPU budget is checked by kit.test.ts on the
    // unwrapped engine; here the tracing would count against it.
    report = runKit(wrapped, { mode: "fast", manifest, cpuClock: threadCpuClock().now });
  }, 600_000);

  it("passes the kit through the tracing wrapper", () => {
    expect(report.failures.filter((failure) => failure.property !== "cpu")).toEqual([]);
    expect(seen.games.filter((game) => game.ending !== null).length).toBeGreaterThanOrEqual(300);
  });

  it.for(GRIDS.map((grid) => grid.id))(
    "ends at least 90 % of the games with no seat leaving all-found on %s",
    (grid, { annotate }) => {
      const games = seen.games.filter(
        (game) => game.grid === grid && game.ending?.anyoneLeft === false,
      );
      const allFound = games.filter((game) => game.ending?.reason === "all-found");
      const bySeats = [2, 3, 4, 5, 6].map((seats) => {
        const at = games.filter((game) => game.seats === seats);
        const found = at.filter((game) => game.ending?.reason === "all-found").length;
        return `${String(seats)} seats ${String(found)}/${String(at.length)}`;
      });
      void annotate(
        `${grid}: all-found in ${String(allFound.length)} of ${String(games.length)} (${bySeats.join(", ")})`,
      );
      expect(games.length).toBeGreaterThanOrEqual(30);
      expect(allFound.length / games.length).toBeGreaterThanOrEqual(0.9);
    },
  );

  it.for(GRIDS.map((grid) => grid.id))(
    "samples in-progress states with at most 4 hidden cards on %s",
    (grid, { annotate }) => {
      void annotate(`${grid}: fewest hidden cards sampled ${String(seen.fewestHidden.get(grid))}`);
      expect(seen.fewestHidden.get(grid)).toBeLessThanOrEqual(4);
    },
  );
});
