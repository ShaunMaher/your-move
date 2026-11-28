/**
 * Test helpers for the pairs package: a source that refuses draws and a state builder for rules
 * tables. Never imported by the engine, client or manifest, and left out of the published files.
 */
import type { RandomSource, Seat } from "@your-move/sdk";

import { gridOf, type Action, type GridId, type Options } from "./engine/schemas.js";
import type { LastMiss, Out, State } from "./engine/state.js";

/** A source that must never be drawn from: proves a transition uses no randomness. */
export const noRandom: RandomSource = {
  nextInt() {
    throw new Error("drew a random value");
  },
};

/** The default options. */
export const OPTIONS: Options = { grid: "4x5" };

/** A rules-table state; everything not given takes a neutral value. */
export interface Table {
  readonly grid?: GridId;
  readonly seats?: number;
  /**
   * The layout by card index. By default card `2k` and card `2k + 1` hold face `k`, so cards 0
   * and 1 are a pair, 2 and 3 another, and so on.
   */
  readonly faces?: readonly number[];
  /** Cards already matched, and by whom. */
  readonly matched?: readonly (readonly [card: number, seat: Seat])[];
  readonly turned?: number | null;
  readonly lastMiss?: LastMiss | null;
  readonly turn?: Seat | null;
  readonly out?: readonly (Out | null)[];
  readonly moves?: number;
}

/** Builds a state for a rules table. */
export function game(table: Table = {}): State {
  const grid = table.grid ?? OPTIONS.grid;
  const { pairs } = gridOf(grid);
  const faces = table.faces ?? Array.from({ length: pairs * 2 }, (_, card) => Math.floor(card / 2));
  const matchedBy: (Seat | null)[] = faces.map(() => null);
  for (const [card, seat] of table.matched ?? []) matchedBy[card] = seat;
  const seats = table.seats ?? table.out?.length ?? 2;
  return {
    options: { grid },
    faces: [...faces],
    matchedBy,
    turned: table.turned ?? null,
    lastMiss: table.lastMiss ?? null,
    turn: table.turn === undefined ? 0 : table.turn,
    out: table.out === undefined ? Array.from({ length: seats }, () => null) : [...table.out],
    moves: table.moves ?? 10,
    endReason: null,
  };
}

/** Every card of the default layout matched by `seat`, except the cards listed. */
export function allMatchedBut(
  state: State,
  except: readonly number[],
  seat: Seat = 0,
): (readonly [number, Seat])[] {
  return state.faces.flatMap((_, card) => (except.includes(card) ? [] : [[card, seat] as const]));
}

/** The flip of card index `card` on a grid of `columns` columns. */
export function flipAt(card: number, columns = gridOf(OPTIONS.grid).columns): Action {
  return { type: "flip", row: Math.floor(card / columns), column: card % columns };
}
