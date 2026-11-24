/**
 * A simple, seeded player for the test kit's `randomAction` and the property tests
 * (docs/spec/02-game-framework.md §6, games/words.md §10.7). It knows the dictionary only through
 * `has(word)` (02 §2 `Resources`), so it samples candidate plays around the tiles already on the
 * board and keeps the first one that validates. It is deliberately not strong: its job is to
 * reach every rule, not to win.
 */
import { isGameError, shuffle, type RandomSource, type Resources, type Seat } from "@your-move/sdk";

import { at } from "./at.js";
import { isBoardEmpty, squareAt, type Board } from "./board.js";
import { check } from "./rules.js";
import { BLANK, type Ruleset } from "./rulesets/schema.js";
import type { Placement, PlayAction } from "./schemas.js";
import { rackOf, rulesetOf, type State } from "./state.js";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** Random candidate plays tried first, on an empty board and later. */
const OPENING_TRIES = 200;
const PLAY_TRIES = 20;
/** Single-tile plays tried after them before the bot gives up and swaps or passes. */
const SINGLE_TILE_CHECKS = 300;

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

/** What candidate plays are drawn from, worked out once per search. */
interface Situation {
  readonly ruleset: Ruleset;
  readonly rack: readonly string[];
  readonly spots: readonly (readonly [number, number])[];
  readonly opening: boolean;
}

function situation(state: State, seat: Seat): Situation {
  const ruleset = rulesetOf(state.options);
  return {
    ruleset,
    rack: rackOf(state, seat),
    spots: anchors(ruleset, state.board),
    opening: isBoardEmpty(state.board),
  };
}

/**
 * A random candidate play by `seat`'s rack around an anchor: usually short, sometimes long.
 * Null if the chosen line doesn't fit on the board.
 */
export function candidatePlay(
  state: State,
  seat: Seat,
  rng: RandomSource,
  { ruleset, rack, spots, opening }: Situation = situation(state, seat),
): PlayAction | null {
  if (spots.length === 0 || rack.length === 0) return null;
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

/**
 * A legal play for `seat`, or null if none turned up: first random candidates of any length (so
 * long words and bingos happen), then single tiles tried at the anchors in random order, which
 * finds a play on most boards.
 */
export function findPlay(
  state: State,
  seat: Seat,
  rng: RandomSource,
  res: Resources,
): PlayAction | null {
  const here = situation(state, seat);
  const legal = (play: PlayAction | null): play is PlayAction =>
    play !== null && !isGameError(check(state, seat, play, res));
  const tries = here.opening ? OPENING_TRIES : PLAY_TRIES;
  for (let i = 0; i < tries; i += 1) {
    const play = candidatePlay(state, seat, rng, here);
    if (legal(play)) return play;
  }
  if (here.opening) return null;
  const tiles = shuffle([...new Set(here.rack)], rng);
  let checks = 0;
  for (const anchor of shuffle(here.spots, rng)) {
    for (const tile of tiles) {
      const placements = placeTiles([anchor], [tile], rng);
      // Looking the words up first is much cheaper than a full check of a play that fails.
      if (wordsThrough(state.board, anchor, at(placements, 0).letter ?? tile).every(has(res))) {
        const play: PlayAction = { type: "play", placements };
        if (legal(play)) return play;
      }
      checks += 1;
      if (checks >= SINGLE_TILE_CHECKS) return null;
    }
  }
  return null;
}

/** A dictionary lookup that accepts nothing without a dictionary. */
function has(res: Resources): (word: string) => boolean {
  return (word) => res.dictionary?.has(word) === true;
}

/** The words (runs of two or more) a single tile with `letter` would form on an empty square. */
function wordsThrough(
  board: Board,
  [row, col]: readonly [number, number],
  letter: string,
): string[] {
  const letterAt = (r: number, c: number): string | undefined => squareAt(board, r, c)?.letter;
  const words: string[] = [];
  for (const [dr, dc] of [
    [0, 1],
    [1, 0],
  ] as const) {
    let before = "";
    for (let r = row - dr, c = col - dc, l = letterAt(r, c); l !== undefined;) {
      before = l + before;
      [r, c] = [r - dr, c - dc];
      l = letterAt(r, c);
    }
    let after = "";
    for (let r = row + dr, c = col + dc, l = letterAt(r, c); l !== undefined;) {
      after += l;
      [r, c] = [r + dr, c + dc];
      l = letterAt(r, c);
    }
    if (before.length + after.length > 0) words.push(before + letter + after);
  }
  return words;
}
