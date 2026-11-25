/**
 * Replay (docs/spec/02-game-framework.md §5, 04 invariant 1): `setup` with the recorded start
 * draws, then every logged transition dispatched by kind with its own recorded draws, must
 * reproduce the stored state exactly. Draws are `[maxExclusive, value]` pairs, so a replay that
 * asks for another range than was recorded fails instead of drifting. An audit and corruption
 * check; the framework's tests run it on every game they play.
 */
import { type AnyGameDefinition, assertRange, type RandomSource } from "@your-move/sdk";

import type { GameActionRecord, GameRecord } from "../db/repositories.js";

/** Thrown when the recorded draws don't fit what the engine asks for. */
class ReplayError extends Error {
  override readonly name = "ReplayError";
}

/** A source returning recorded draws in order, checking each range. */
function replaying(json: string | null): RandomSource & { remaining(): number } {
  const draws = (json === null ? [] : JSON.parse(json)) as [number, number][];
  let next = 0;
  return {
    nextInt(maxExclusive) {
      assertRange(maxExclusive);
      const draw = draws[next];
      if (draw === undefined) throw new ReplayError(`draw ${String(next)} was never recorded`);
      if (draw[0] !== maxExclusive) {
        throw new ReplayError(`draw ${String(next)} was recorded for another range`);
      }
      next += 1;
      return draw[1];
    },
    remaining: () => draws.length - next,
  };
}

/** The state `setup` and the logged transitions reproduce, or a {@link ReplayError}. */
export function replayState(
  definition: AnyGameDefinition,
  game: GameRecord,
  actions: readonly GameActionRecord[],
): unknown {
  const options = definition.optionsSchema.parse(JSON.parse(game.options));
  const start = replaying(game.setupRng);
  // A random seat order is the start's first draws: the shuffle of the joined rows (02 §4 step 4).
  if (game.seatOrder === "random") {
    for (let i = game.seats - 1; i > 0; i -= 1) start.nextInt(i + 1);
  }
  let state = definition.setup({ options, seats: game.seats, rng: start });
  if (start.remaining() !== 0) throw new ReplayError("setup left recorded draws unused");
  for (const entry of actions) {
    const rng = replaying(entry.rng);
    const transition =
      entry.kind === "action"
        ? definition.apply(state, entry.seat, JSON.parse(entry.action ?? "null"), rng)
        : entry.kind === "timeout"
          ? definition.onTimeout(state, entry.seat, rng)
          : definition.onResign(
              state,
              entry.seat,
              rng,
              entry.kind === "resign" ? "resign" : "decline",
            );
    if (rng.remaining() !== 0)
      throw new ReplayError(`action ${String(entry.seq)} left draws unused`);
    state = transition.state;
  }
  return state;
}
