/**
 * The board: placement rules, word finding and scoring (docs/spec/games/words.md §3.1, §4).
 *
 * `analysePlay` runs every `INVALID_PLACEMENT` check of words §10.3 in order, from the submitter's
 * rack and the public board only (the secrecy contract, words §7), then finds the words the play
 * forms and scores them. It never looks a word up: the dictionary check comes last, in
 * `validate` (words §10.3), so a play that breaks a placement rule never reaches the word list.
 */
import type { GameError } from "@your-move/sdk";

import { BLANK, type Premium, type Ruleset } from "./rulesets/schema.js";
import { ERROR_CODES, type Placement, type PlacementError, type ScoredWord } from "./schemas.js";

/** A tile on the board: its code (`?` for a blank) and the letter it stands for. */
export interface BoardTile {
  readonly tile: string;
  readonly letter: string;
}

/** `boardSize` rows of `boardSize` squares; null is an empty square. */
export type Board = readonly (readonly (BoardTile | null)[])[];

/** A play the placement rules accept: the words it forms (main word first) and its score. */
export interface PlayAnalysis {
  readonly words: readonly ScoredWord[];
  /** The sum of the word scores plus the bingo bonus (words §4). */
  readonly score: number;
  /** Whether the play used `rackSize` tiles (words §4, glossary "Bingo"). */
  readonly bingo: boolean;
}

/** An empty board for a ruleset. */
export function emptyBoard(ruleset: Ruleset): (BoardTile | null)[][] {
  const size = ruleset.boardSize;
  return Array.from({ length: size }, () => Array.from({ length: size }, () => null));
}

/** The tile on a square, or null if it is empty or off the board. */
export function squareAt(board: Board, row: number, col: number): BoardTile | null {
  return board[row]?.[col] ?? null;
}

/** Whether no tile has been played yet (words §3.1 rule 4). */
export function isBoardEmpty(board: Board): boolean {
  return board.every((row) => row.every((square) => square === null));
}

/** A tile's point value; a blank is worth 0 (words §1). */
export function tilePoints(ruleset: Ruleset, tile: string): number {
  return Object.hasOwn(ruleset.tiles, tile) ? (ruleset.tiles[tile]?.points ?? 0) : 0;
}

const PREMIUMS: Readonly<Record<string, Premium>> = { d: "DL", t: "TL", D: "DW", T: "TW" };
const LETTER_MULTIPLIER: Readonly<Record<Premium, number>> = { DL: 2, TL: 3, DW: 1, TW: 1 };
const WORD_MULTIPLIER: Readonly<Record<Premium, number>> = { DL: 1, TL: 1, DW: 2, TW: 3 };

/** The premium on a square (words §8.1), or null for a normal square. */
export function premiumAt(ruleset: Ruleset, row: number, col: number): Premium | null {
  const code = ruleset.premiums[row]?.[col];
  return code !== undefined && Object.hasOwn(PREMIUMS, code) ? (PREMIUMS[code] ?? null) : null;
}

/**
 * Placements in board order (by row, then column): along the line for a legal play, so records,
 * the order of cross-words and every answer are the same whatever order the client sent them in.
 */
export function inLineOrder<T extends { readonly row: number; readonly col: number }>(
  placements: readonly T[],
): T[] {
  return [...placements].sort((a, b) => a.row - b.row || a.col - b.col);
}

function placementError(detail: PlacementError): GameError {
  return { code: ERROR_CODES.invalidPlacement, detail };
}

/** A square in a word, and whether this play placed it. */
interface WordSquare {
  readonly row: number;
  readonly col: number;
  readonly tile: string;
  readonly letter: string;
  readonly placed: boolean;
}

/**
 * Checks a play's placements against the rules of words §3.1, in the order of words §10.3 (the
 * dictionary aside), and, if they hold, finds and scores the words formed.
 */
export function analysePlay(
  ruleset: Ruleset,
  board: Board,
  rack: readonly string[],
  given: readonly Placement[],
): PlayAnalysis | GameError {
  const placements = inLineOrder(given);
  const size = ruleset.boardSize;
  if (placements.length > ruleset.rackSize) return placementError("TOO_MANY_TILES");
  if (placements.some((p) => p.row >= size || p.col >= size)) {
    return placementError("OUT_OF_BOUNDS");
  }
  const placed = new Map<number, BoardTile>();
  for (const p of placements) {
    const key = p.row * size + p.col;
    if (placed.has(key)) return placementError("DUPLICATE_SQUARE");
    placed.set(key, { tile: p.tile, letter: p.letter ?? p.tile });
  }
  if (placements.some((p) => squareAt(board, p.row, p.col) !== null)) {
    return placementError("SQUARE_OCCUPIED");
  }
  for (const p of placements) {
    if (p.tile === BLANK && p.letter === undefined) return placementError("BLANK_NEEDS_LETTER");
    if (p.tile !== BLANK && p.letter !== undefined) return placementError("LETTER_ON_NON_BLANK");
  }
  const left = [...rack];
  for (const p of placements) {
    const index = left.indexOf(p.tile);
    if (index === -1) return placementError("TILE_NOT_IN_RACK");
    left.splice(index, 1);
  }

  const first = placements[0];
  /* v8 ignore next -- the action schema requires at least one placement */
  if (first === undefined) return placementError("TOO_FEW_TILES");
  const tileAt = (row: number, col: number): BoardTile | null =>
    row < 0 || col < 0 || row >= size || col >= size
      ? null
      : (placed.get(row * size + col) ?? squareAt(board, row, col));

  // The play line: a row (dr 0, dc 1) or a column (dr 1, dc 0). A single tile has none.
  let line: readonly [number, number] | null = null;
  if (placements.length > 1) {
    if (placements.every((p) => p.row === first.row)) line = [0, 1];
    else if (placements.every((p) => p.col === first.col)) line = [1, 0];
    else return placementError("NOT_IN_LINE");
    const along = placements.map((p) => (line?.[0] === 0 ? p.col : p.row));
    const [from, to] = [Math.min(...along), Math.max(...along)];
    for (let i = from; i <= to; i += 1) {
      const [row, col] = line[0] === 0 ? [first.row, i] : [i, first.col];
      if (tileAt(row, col) === null) return placementError("GAP");
    }
  }

  if (isBoardEmpty(board)) {
    if (placements.length < 2) return placementError("TOO_FEW_TILES");
    const [startRow, startCol] = ruleset.start;
    if (!placements.some((p) => p.row === startRow && p.col === startCol)) {
      return placementError("START_NOT_COVERED");
    }
  } else {
    const touches = placements.some((p) =>
      NEIGHBOURS.some(([dr, dc]) => squareAt(board, p.row + dr, p.col + dc) !== null),
    );
    if (!touches) return placementError("NOT_CONNECTED");
  }

  /** The maximal run of tiles through a square along a direction. */
  const run = (row: number, col: number, dr: number, dc: number): WordSquare[] => {
    let [r, c] = [row, col];
    while (tileAt(r - dr, c - dc) !== null) [r, c] = [r - dr, c - dc];
    const squares: WordSquare[] = [];
    for (let tile = tileAt(r, c); tile !== null; tile = tileAt(r, c)) {
      squares.push({ row: r, col: c, ...tile, placed: placed.has(r * size + c) });
      [r, c] = [r + dr, c + dc];
    }
    return squares;
  };

  const runs =
    line === null
      ? [run(first.row, first.col, 0, 1), run(first.row, first.col, 1, 0)]
      : [
          run(first.row, first.col, line[0], line[1]),
          ...placements.map((p) => run(p.row, p.col, line[1], line[0])),
        ];
  const words = runs.filter((squares) => squares.length >= 2).map((w) => scoreWord(ruleset, w));
  // A guard only: the checks above leave no way to form no word (an opening has 2+ tiles in a
  // line, a later single tile touches a tile, and 2+ tiles in a line are a word), but if a
  // rule ever changes, refusing is the safe answer (words §3.1 rule 6).
  /* v8 ignore next */
  if (words.length === 0) return placementError("NO_WORD_FORMED");
  const bingo = placements.length === ruleset.rackSize;
  const score = words.reduce((sum, word) => sum + word.score, bingo ? ruleset.bingoBonus : 0);
  return { words, score, bingo };
}

const NEIGHBOURS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

/** One word's score (words §4): premiums count only under tiles this play placed. */
function scoreWord(ruleset: Ruleset, squares: readonly WordSquare[]): ScoredWord {
  let sum = 0;
  let multiplier = 1;
  for (const square of squares) {
    const premium = square.placed ? premiumAt(ruleset, square.row, square.col) : null;
    const points = tilePoints(ruleset, square.tile);
    sum += premium === null ? points : points * LETTER_MULTIPLIER[premium];
    if (premium !== null) multiplier *= WORD_MULTIPLIER[premium];
  }
  return { word: squares.map((square) => square.letter).join(""), score: sum * multiplier };
}
