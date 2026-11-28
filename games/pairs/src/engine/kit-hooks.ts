/**
 * The hooks the generic test kit drives the pairs game with (docs/spec/02-game-framework.md §6,
 * docs/spec/games/pairs.md §8.7). They are part of the contract (02 §2 `test`), so they ship with
 * the engine and stay pure.
 */
import {
  shuffle,
  type GameTestHooks,
  type RandomSource,
  type Seat,
  type WorstCase,
} from "@your-move/sdk";

import { at } from "./at.js";
import { turnable } from "./rules.js";
import { gridOf, type Action, type Options } from "./schemas.js";
import { flip, gridFor, setup, type State } from "./state.js";

/** One of `items`, chosen with `rng`. */
function pick<T>(items: readonly T[], rng: RandomSource): T {
  return at(items, rng.nextInt(items.length));
}

/** The flip of card index `card`. */
function flipOf(state: State, card: number): Action {
  const { columns } = gridFor(state);
  return { type: "flip", row: Math.floor(card / columns), column: card % columns };
}

/** The cards that may be turned now: every card neither matched nor up (`missed` ones included). */
function legalCards(state: State): number[] {
  return state.faces.flatMap((_, card) => (turnable(state, card) ? [card] : []));
}

/** A uniformly random legal flip (pairs §8.7). It reads no face. */
function randomAction(state: State, _seat: Seat, rng: RandomSource): Action {
  return flipOf(state, pick(legalCards(state), rng));
}

/**
 * A schema-valid flip, often illegal (pairs §8.7): mostly a uniformly random card of the grid,
 * whatever its state; sometimes a row or column one outside the grid; now and then a large
 * integer.
 */
function randomAnyAction(state: State, _seat: Seat, rng: RandomSource): Action {
  const { rows, columns } = gridFor(state);
  const roll = rng.nextInt(10);
  const row = rng.nextInt(rows);
  const column = rng.nextInt(columns);
  if (roll === 0) {
    const large = 2 ** 31 + rng.nextInt(2 ** 20);
    return rng.nextInt(2) === 0
      ? { type: "flip", row: large, column }
      : { type: "flip", row, column: -large };
  }
  if (roll <= 2) {
    const off = (size: number): number => (rng.nextInt(2) === 0 ? -1 : size);
    return rng.nextInt(2) === 0
      ? { type: "flip", row: off(rows), column }
      : { type: "flip", row, column: off(columns) };
  }
  return { type: "flip", row, column };
}

/**
 * The hidden cards (pairs §8.1): neither matched, nor up, nor in the shown missed pair. None once
 * the game is over.
 */
export function hiddenCards(state: State): number[] {
  if (state.endReason !== null) return [];
  const shown = new Set(state.lastMiss?.cards ?? []);
  return state.faces.flatMap((_, card) =>
    turnable(state, card) && !shown.has(card) ? [card] : [],
  );
}

/**
 * Shuffles the faces of the hidden cards among them (pairs §8.7), the same for every viewer:
 * nothing is hidden from one viewer that another sees. If the shuffle reproduces the layout while
 * two hidden faces differ, the first hidden card's face is swapped with the first later one that
 * differs, so the state changes whenever it can. A finished game is returned unchanged.
 */
function perturbHidden(state: State, _viewer: Seat | null, rng: RandomSource): State {
  const hidden = hiddenCards(state);
  if (hidden.length === 0) return state;
  const shuffled = shuffle(
    hidden.map((card) => at(state.faces, card)),
    rng,
  );
  const faces = [...state.faces];
  hidden.forEach((card, i) => {
    faces[card] = at(shuffled, i);
  });
  if (faces.every((face, card) => face === state.faces[card])) {
    const first = at(hidden, 0);
    const other = hidden.find((card) => at(state.faces, card) !== at(state.faces, first));
    if (other !== undefined) {
      faces[first] = at(state.faces, other);
      faces[other] = at(state.faces, first);
    }
  }
  return { ...state, faces };
}

/**
 * The termination bound (pairs §8.7): the move limit `L = 4 × pairs²` and at most `seats` more
 * transitions after the one that reaches it, plus a margin of one.
 */
function maxActions(options: Options, seats: number): number {
  return gridOf(options.grid).moveLimit + seats + 1;
}

/** The option inputs the kit plays (pairs §8.7): every grid (`{}` is `4x5`), each at 2–6 seats. */
function optionInputs(): readonly unknown[] {
  return [{}, { grid: "4x4" }, { grid: "5x6" }, { grid: "6x6" }];
}

/** The four kinds of input `worstCase` returns, in this order (pairs §8.7, §10). */
export const WORST_KINDS = ["clears-miss", "misses", "last-pair", "move-limit"] as const;
export type WorstKind = (typeof WORST_KINDS)[number];

/** A first card that is legal now, chosen uniformly. */
const firstCard = (state: State, rng: RandomSource): number => pick(legalCards(state), rng);

/** The other card with the up card's face. */
function partnerOf(state: State, card: number): number {
  const face = at(state.faces, card);
  const partner = state.faces.findIndex((other, index) => other === face && index !== card);
  if (partner < 0) throw new Error("every face is on two cards");
  return partner;
}

/**
 * The end-game driver: a uniform first card, and a second card that is the up card's partner half
 * the time (otherwise any other legal card), so the game reaches its end. Returns the first input
 * of each kind it passes through, keyed by kind.
 */
function playToEnd(
  options: Options,
  seats: number,
  rng: RandomSource,
): Map<WorstKind, WorstCase<State, Action>> {
  const found = new Map<WorstKind, WorstCase<State, Action>>();
  let state = setup({ options, seats, rng });
  while (state.turn !== null) {
    const seat = state.turn;
    const up = state.turned;
    let card: number;
    if (up === null) {
      card = firstCard(state, rng);
      if (state.lastMiss !== null && !found.has("clears-miss")) {
        found.set("clears-miss", { state, seat, action: flipOf(state, card) });
      }
    } else {
      const others = legalCards(state);
      card = rng.nextInt(2) === 0 ? partnerOf(state, up) : pick(others, rng);
      const matches = at(state.faces, card) === at(state.faces, up);
      const last = matches && state.matchedBy.filter((by) => by === null).length === 2;
      const kind = last ? "last-pair" : matches ? null : "misses";
      if (kind !== null && !found.has(kind)) {
        found.set(kind, { state, seat, action: flipOf(state, card) });
      }
    }
    state = flip(state, seat, card).state;
  }
  return found;
}

/**
 * The move-limit driver: it always misses on purpose (a second card whose face differs from the up
 * card's, possible from the start since no pair is ever found) until the second card that reaches
 * the move limit, which ends the game `move-limit`. Returns that last input.
 */
function missToLimit(options: Options, seats: number, rng: RandomSource): WorstCase<State, Action> {
  const { moveLimit } = gridOf(options.grid);
  let state = setup({ options, seats, rng });
  for (;;) {
    const seat = state.turn;
    if (seat === null) throw new Error("the game ended before the move limit");
    const up = state.turned;
    const card =
      up === null
        ? firstCard(state, rng)
        : pick(
            legalCards(state).filter((other) => at(state.faces, other) !== at(state.faces, up)),
            rng,
          );
    const input = { state, seat, action: flipOf(state, card) };
    if (up !== null && state.moves + 1 >= moveLimit) return input;
    state = flip(state, seat, card).state;
  }
}

/** How many end-game drives `worstCase` may make before it gives up on finding every kind. */
const DRIVES = 20;

/**
 * The most expensive inputs for the CPU budget (02 §6.6, pairs §8.7), built by seeded play from
 * `setup`, so every input is a reachable state: a first card that clears a shown missed pair, a
 * second card that misses (the next-seat search), the second card that finds the last pair (the
 * end and the ranking) and the second card that reaches the move limit. `validate` is a few
 * lookups and `apply` copies at most 36 cards and 6 seats, so no input is far costlier than
 * another; these cover every branch `apply` takes.
 */
export function worstCases(
  options: Options,
  seats: number,
  rng: RandomSource,
): Map<WorstKind, WorstCase<State, Action>> {
  const found = new Map<WorstKind, WorstCase<State, Action>>();
  for (let drive = 0; drive < DRIVES && found.size < WORST_KINDS.length - 1; drive += 1) {
    for (const [kind, input] of playToEnd(options, seats, rng)) {
      if (!found.has(kind)) found.set(kind, input);
    }
  }
  found.set("move-limit", missToLimit(options, seats, rng));
  // Every kind, in order; a missing one is a bug in the drivers, so it throws (02 §2.1 rule 3).
  return new Map(
    WORST_KINDS.map((kind) => {
      const input = found.get(kind);
      if (input === undefined) throw new Error(`worstCase found no ${kind} input`);
      return [kind, input] as const;
    }),
  );
}

function worstCase(
  options: Options,
  seats: number,
  rng: RandomSource,
): readonly WorstCase<State, Action>[] {
  return [...worstCases(options, seats, rng).values()];
}

export const testHooks: GameTestHooks<Options, State, Action> = {
  randomAction,
  randomAnyAction,
  perturbHidden,
  hiddenInformation: true,
  hiddenFromEveryone: true,
  maxActions,
  worstCase,
  optionInputs,
};
