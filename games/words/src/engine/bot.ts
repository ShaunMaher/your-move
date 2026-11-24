/**
 * A simple, seeded player for the test kit's `randomAction` and the property tests
 * (docs/spec/02-game-framework.md §6, games/words.md §10.7). It knows the dictionary only through
 * `has(word)` (02 §2 `Resources`), so it samples candidate plays around the tiles already on the
 * board and keeps the first one that validates. It is deliberately not strong: its job is to
 * reach every rule, not to win.
 */
import { isGameError, type RandomSource, type Resources, type Seat } from "@your-move/sdk";

import { at } from "./at.js";
import { isBoardEmpty, squareAt, type Board } from "./board.js";
import { check } from "./rules.js";
import { BLANK, type Ruleset } from "./rulesets/schema.js";
import type { Placement, PlayAction } from "./schemas.js";
import { rackOf, rulesetOf, type State } from "./state.js";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** Candidate plays tried before the bot gives up and swaps or passes. */
const PLAY_TRIES = 40;

/** `count` distinct items of `items`, in random order. */
export function sample<T>(items: readonly T[], count: number, rng: RandomSource): T[] {
  const pool = [...items];
  const chosen: T[] = [];
  for (let i = 0; i < count && pool.length > 0; i += 1) {
    chosen.push(...pool.splice(rng.nextInt(pool.length), 1));
  }
  return chosen;
}

/** A random letter of the alphabet, for a blank. */
export function randomLetter(rng: RandomSource): string {
  return at(LETTERS.split(""), rng.nextInt(LETTERS.length));
}

/** The empty squares a play must touch: next to a tile, or the start square on an empty board. */
export function anchors(ruleset: Ruleset, board: Board): [number, number][] {
  if (isBoardEmpty(board)) return [[...ruleset.start]];
  const found: [number, number][] = [];
  for (let row = 0; row < ruleset.boardSize; row += 1) {
    for (let col = 0; col < ruleset.boardSize; col += 1) {
      if (squareAt(board, row, col) !== null) continue;
      const touches =
        squareAt(board, row - 1, col) !== null ||
        squareAt(board, row + 1, col) !== null ||
        squareAt(board, row, col - 1) !== null ||
        squareAt(board, row, col + 1) !== null;
      if (touches) found.push([row, col]);
    }
  }
  return found;
}

/**
 * `count` empty squares in one line through `anchor`: the anchor, `before` empty squares before
 * it and the rest after it, skipping squares already filled (they become part of the word).
 * Null if the line runs off the board first.
 */
export function lineSquares(
  ruleset: Ruleset,
  board: Board,
  anchor: readonly [number, number],
  vertical: boolean,
  count: number,
  before: number,
): [number, number][] | null {
  const [dr, dc] = vertical ? [1, 0] : [0, 1];
  const size = ruleset.boardSize;
  const squares: [number, number][] = [[anchor[0], anchor[1]]];
  const walk = (step: number, wanted: number): boolean => {
    let [row, col] = anchor;
    for (let found = 0; found < wanted;) {
      [row, col] = [row + step * dr, col + step * dc];
      if (row < 0 || col < 0 || row >= size || col >= size) return false;
      if (squareAt(board, row, col) === null) {
        squares.push([row, col]);
        found += 1;
      }
    }
    return true;
  };
  return walk(-1, before) && walk(1, count - 1 - before) ? squares : null;
}

/** Placements of `tiles` on `squares`, with a random letter for each blank. */
export function placeTiles(
  squares: readonly (readonly [number, number])[],
  tiles: readonly string[],
  rng: RandomSource,
): Placement[] {
  return squares.map(([row, col], index) => {
    const tile = at(tiles, index);
    return tile === BLANK ? { row, col, tile, letter: randomLetter(rng) } : { row, col, tile };
  });
}

/**
 * A random candidate play by `seat`'s rack around an anchor: usually short, sometimes long.
 * Null if the chosen line doesn't fit on the board.
 */
export function candidatePlay(state: State, seat: Seat, rng: RandomSource): PlayAction | null {
  const ruleset = rulesetOf(state.options);
  const rack = rackOf(state, seat);
  const spots = anchors(ruleset, state.board);
  if (spots.length === 0 || rack.length === 0) return null;
  const opening = isBoardEmpty(state.board);
  // Short plays succeed far more often; the minimum of two draws favours them.
  const longest = Math.min(rack.length, ruleset.rackSize);
  let count = 1 + Math.min(rng.nextInt(longest), rng.nextInt(longest));
  if (opening) count = Math.max(2, count);
  if (count > rack.length) return null;
  const squares = lineSquares(
    ruleset,
    state.board,
    at(spots, rng.nextInt(spots.length)),
    rng.nextInt(2) === 1,
    count,
    rng.nextInt(count),
  );
  if (squares === null) return null;
  return { type: "play", placements: placeTiles(squares, sample(rack, count, rng), rng) };
}

/** A legal play for `seat` found by sampling, or null if none turned up. */
export function findPlay(
  state: State,
  seat: Seat,
  rng: RandomSource,
  res: Resources,
  tries = PLAY_TRIES,
): PlayAction | null {
  for (let i = 0; i < tries; i += 1) {
    const play = candidatePlay(state, seat, rng);
    if (play !== null && !isGameError(check(state, seat, play, res))) return play;
  }
  return null;
}
