/**
 * The no-play search (docs/spec/games/words.md §10.8): whether a rack has any legal play on a
 * board, for the board's "no word can be played" hint. It sees only what the viewer's view holds
 * (the public board and the viewer's own rack) and a `public` word list, never another seat's
 * rack or the bag.
 *
 * The search is the classic anchor-square method: every play covers an *anchor* (an empty square
 * next to a tile, or the start square on an empty board), so each line is searched outwards from
 * its anchors, letter by letter, pruned by the word list's prefixes and by *cross-checks* (the
 * letters that make a valid word across the line on each square). It is exhaustive: when it
 * finishes without a play, no legal play exists. A play it finds is confirmed with the engine's
 * own `analysePlay` and the same word list, so the hint and the server agree.
 *
 * It is pure and deterministic: its work is counted in steps (one per search node and one per
 * word-list question), never timed. Past `maxSteps` it gives up and says `unknown`, so a caller
 * never reports "no play" it didn't prove.
 */
import { isGameError } from "@your-move/sdk";

import { at } from "./at.js";
import { analysePlay, isBoardEmpty, type Board } from "./board.js";
import { BLANK, type Ruleset } from "./rulesets/schema.js";
import type { Placement } from "./schemas.js";

/**
 * A word list the search can walk like a tree of prefixes: a public list as the shell hands it to
 * the board (`BoardResources["dictionary"]`, 02 §3), a binary search over its sorted text.
 */
export interface Lexicon {
  /** Whether `word` is in the list. */
  has(word: string): boolean;
  /** The letters that follow `prefix` in some word of the list, as a bit mask (bit 0 is `a`). */
  follows(prefix: string): number;
}

/**
 * The step limit the board's hint uses (words §10.8), from the measurements in
 * `moves.benchmark.test.ts`: on realistic boards a rack with a play finds one in a few thousand
 * steps, and proving there is none fits inside the limit with no blank, and usually with one. The
 * whole limit is about 36 ms on a desktop machine, so a few hundred milliseconds of sliced work on
 * a slow phone. A rack with blanks and no play may run past it: the answer is `unknown`, and the
 * board says nothing.
 */
export const HINT_MAX_STEPS = 150_000;

const A = 97;
const LETTER_COUNT = 26;
const ALL_LETTERS = (1 << LETTER_COUNT) - 1;
/** What the search found: a play (the first it met), proof there is none, or no answer. */
export type SearchOutcome =
  | { readonly kind: "some"; readonly play: readonly Placement[] }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" };

/** A search that runs a slice at a time, so a caller can yield between slices. */
export interface PlaySearch {
  /** Searches on for about `steps` more steps: the outcome once known, else null. */
  advance(steps: number): SearchOutcome | null;
  /** The steps used so far. */
  readonly steps: number;
}

/** What the search is given: the public board and the viewer's own rack (words §7). */
export interface SearchInput {
  readonly ruleset: Ruleset;
  readonly board: Board;
  readonly rack: readonly string[];
  readonly lexicon: Lexicon;
  /** The most steps the whole search may take before it says `unknown`. */
  readonly maxSteps: number;
}

/** Runs a whole search at once: for tests, benchmarks and callers that needn't yield. */
export function hasAnyPlay(input: SearchInput): SearchOutcome {
  const search = searchPlays(input);
  for (;;) {
    const outcome = search.advance(input.maxSteps);
    if (outcome !== null) return outcome;
  }
}

/** A line of the board: a row (across) or a column (down), read as positions 0..size-1. */
interface Line {
  readonly down: boolean;
  readonly index: number;
}

/** One piece of the search: the cross-checks of a direction, or one anchor's plays of up to `tiles`. */
type Unit =
  | { readonly kind: "crossChecks"; readonly down: boolean }
  | { readonly kind: "anchor"; readonly line: Line; readonly pos: number; readonly tiles: number };

/**
 * Plays of at most this many tiles are tried everywhere first: a short play exists on almost every
 * board, and finding it first keeps the usual answer quick even when blanks make long plays
 * numerous. Then every length is tried, so the search stays exhaustive.
 */
const SHORT_PLAY = 2;

/** A tile put down during the search: its code (`?` for a blank) and the letter it shows. */
interface Put {
  readonly tile: string;
  readonly letter: string;
}

/** Thrown out of the search when it runs past its step limit. */
class OutOfSteps extends Error {}

/** Starts a search; nothing runs until `advance`. */
export function searchPlays(input: SearchInput): PlaySearch {
  return new Search(input);
}

class Search implements PlaySearch {
  steps = 0;
  private readonly size: number;
  private readonly opening: boolean;
  private readonly units: Unit[] = [];
  private next = 0;
  private outcome: SearchOutcome | null = null;
  /** Rack tiles left, per letter, and blanks left. */
  private readonly counts = new Array<number>(LETTER_COUNT).fill(0);
  private blanks = 0;
  /** The most tiles one play may use: the rack's, and never more than `rackSize` (words §3.1). */
  private readonly most: number;
  /** The most tiles the plays now being searched may use. */
  private limit = 0;
  /** Cross-check masks per direction (`down` ? 1 : 0), by `row * size + col`; ALL off a line. */
  private readonly crossChecks: [number[], number[]] = [[], []];
  /** `follows` answers already asked: prefixes repeat across anchors. */
  private readonly followsCache = new Map<string, number>();
  /** The tiles of the left part and of the right part of the play being built. */
  private readonly left: Put[] = [];
  private readonly right: Put[] = [];

  private readonly input: SearchInput;

  constructor(input: SearchInput) {
    this.input = input;
    const { ruleset, board, rack } = input;
    this.size = ruleset.boardSize;
    this.opening = isBoardEmpty(board);
    this.most = Math.min(rack.length, ruleset.rackSize);
    for (const tile of rack) {
      if (tile === BLANK) this.blanks += 1;
      else this.counts[tile.charCodeAt(0) - A] = at(this.counts, tile.charCodeAt(0) - A) + 1;
    }
    if (this.most === 0) return;
    // An empty board has no cross-words: every letter fits everywhere.
    if (!this.opening) {
      this.units.push({ kind: "crossChecks", down: false }, { kind: "crossChecks", down: true });
    }
    const anchors = this.anchors();
    for (const tiles of new Set([Math.min(SHORT_PLAY, this.most), this.most])) {
      for (const down of [false, true]) {
        for (const [row, col] of anchors) {
          const line = { down, index: down ? col : row };
          this.units.push({ kind: "anchor", line, pos: down ? row : col, tiles });
        }
      }
    }
  }

  advance(budget: number): SearchOutcome | null {
    if (this.outcome !== null) return this.outcome;
    const until = this.steps + budget;
    try {
      while (this.next < this.units.length) {
        const unit = at(this.units, this.next);
        this.next += 1;
        if (unit.kind === "crossChecks") {
          this.crossChecks[unit.down ? 1 : 0] = this.findCrossChecks(unit.down);
        } else {
          this.limit = unit.tiles;
          const play = this.searchAnchor(unit.line, unit.pos);
          if (play !== null) return (this.outcome = { kind: "some", play });
        }
        if (this.steps >= until && this.next < this.units.length) return null;
      }
      return (this.outcome = { kind: "none" });
    } catch (error) {
      if (error instanceof OutOfSteps) return (this.outcome = { kind: "unknown" });
      throw error;
    }
  }

  /** Counts one step; past the limit the search stops. */
  private step(): void {
    this.steps += 1;
    if (this.steps > this.input.maxSteps) throw new OutOfSteps();
  }

  private has(word: string): boolean {
    this.step();
    return this.input.lexicon.has(word);
  }

  private follows(prefix: string): number {
    this.step();
    let mask = this.followsCache.get(prefix);
    if (mask === undefined) {
      mask = this.input.lexicon.follows(prefix);
      this.followsCache.set(prefix, mask);
    }
    return mask;
  }

  /** The squares every play must cover one of (words §3.1 rules 4–5). */
  private anchors(): [number, number][] {
    if (this.opening) return [[...this.input.ruleset.start]];
    const found: [number, number][] = [];
    for (let row = 0; row < this.size; row += 1) {
      for (let col = 0; col < this.size; col += 1) {
        if (this.letterAt(row, col) !== null) continue;
        const touches =
          this.letterAt(row - 1, col) !== null ||
          this.letterAt(row + 1, col) !== null ||
          this.letterAt(row, col - 1) !== null ||
          this.letterAt(row, col + 1) !== null;
        if (touches) found.push([row, col]);
      }
    }
    return found;
  }

  private letterAt(row: number, col: number): string | null {
    if (row < 0 || col < 0 || row >= this.size || col >= this.size) return null;
    return this.input.board[row]?.[col]?.letter ?? null;
  }

  /** The letter on a line's square, or null if it is empty or off the board. */
  private onLine(line: Line, pos: number): string | null {
    return line.down ? this.letterAt(pos, line.index) : this.letterAt(line.index, pos);
  }

  /**
   * Whether an empty square before an anchor is another anchor. On an empty board the start
   * square is the only anchor, so none is.
   */
  private isAnchorBefore(line: Line, pos: number): boolean {
    if (this.opening) return false;
    const [row, col] = line.down ? [pos, line.index] : [line.index, pos];
    return (
      this.letterAt(row - 1, col) !== null ||
      this.letterAt(row + 1, col) !== null ||
      this.letterAt(row, col - 1) !== null ||
      this.letterAt(row, col + 1) !== null
    );
  }

  /**
   * For plays along `down`, the letters each empty square may take so the word across the line
   * through it (if it touches tiles that way) is in the list.
   */
  private findCrossChecks(down: boolean): number[] {
    const masks = new Array<number>(this.size * this.size).fill(ALL_LETTERS);
    // The cross-word runs across the play line: along a row for a play down a column.
    const [dr, dc] = down ? [0, 1] : [1, 0];
    for (let row = 0; row < this.size; row += 1) {
      for (let col = 0; col < this.size; col += 1) {
        if (this.letterAt(row, col) !== null) continue;
        let before = "";
        for (let r = row - dr, c = col - dc, l = this.letterAt(r, c); l !== null;) {
          before = l + before;
          [r, c] = [r - dr, c - dc];
          l = this.letterAt(r, c);
        }
        let after = "";
        for (let r = row + dr, c = col + dc, l = this.letterAt(r, c); l !== null;) {
          after += l;
          [r, c] = [r + dr, c + dc];
          l = this.letterAt(r, c);
        }
        if (before === "" && after === "") continue;
        let mask = 0;
        for (let left = this.follows(before); left !== 0; left &= left - 1) {
          const letter = lowest(left);
          if (this.has(before + String.fromCharCode(A + letter) + after)) mask |= 1 << letter;
        }
        masks[row * this.size + col] = mask;
      }
    }
    return masks;
  }

  private crossCheck(line: Line, pos: number): number {
    const [row, col] = line.down ? [pos, line.index] : [line.index, pos];
    return this.crossChecks[line.down ? 1 : 0][row * this.size + col] ?? ALL_LETTERS;
  }

  /** The letters the rack can put down: all of them with a blank, else those it holds. */
  private rackMask(): number {
    if (this.blanks > 0) return ALL_LETTERS;
    let mask = 0;
    for (let letter = 0; letter < LETTER_COUNT; letter += 1) {
      if (at(this.counts, letter) > 0) mask |= 1 << letter;
    }
    return mask;
  }

  /**
   * Puts down a tile showing `letter` (a real tile when the rack has one, else a blank), runs
   * `then`, and takes it back. A real tile is never worse than a blank for the rest of the play,
   * so the blank is tried only for a letter the rack lacks.
   */
  private withTile(letter: number, into: Put[], then: () => readonly Placement[] | null) {
    const shown = String.fromCharCode(A + letter);
    const real = at(this.counts, letter) > 0;
    if (real) this.counts[letter] = at(this.counts, letter) - 1;
    else this.blanks -= 1;
    into.push({ tile: real ? shown : BLANK, letter: shown });
    try {
      return then();
    } finally {
      into.pop();
      if (real) this.counts[letter] = at(this.counts, letter) + 1;
      else this.blanks += 1;
    }
  }

  /** The plays covering one anchor along one line, whose leftmost anchor it is. */
  private searchAnchor(line: Line, anchor: number): readonly Placement[] | null {
    // Tiles just before the anchor are the fixed start of every word through it.
    let start = anchor;
    let prefix = "";
    for (let l = this.onLine(line, start - 1); l !== null; l = this.onLine(line, start - 1)) {
      prefix = l + prefix;
      start -= 1;
    }
    if (start < anchor) return this.extend(line, anchor, start, prefix);
    // Otherwise up to `limit` tiles may go on the empty squares before it, none of them an
    // anchor (a play reaching an earlier anchor is found from that one).
    let limit = 0;
    while (
      limit < this.limit - 1 &&
      anchor - limit - 1 >= 0 &&
      this.onLine(line, anchor - limit - 1) === null &&
      !this.isAnchorBefore(line, anchor - limit - 1)
    ) {
      limit += 1;
    }
    return this.leftPart(line, anchor, "", limit);
  }

  /** Every left part of up to `limit` more tiles from the rack, each then extended rightwards. */
  private leftPart(
    line: Line,
    anchor: number,
    prefix: string,
    limit: number,
  ): readonly Placement[] | null {
    this.step();
    const found = this.extend(line, anchor, anchor - prefix.length, prefix);
    if (found !== null || limit === 0) return found;
    for (let left = this.follows(prefix) & this.rackMask(); left !== 0; left &= left - 1) {
      const letter = lowest(left);
      const play = this.withTile(letter, this.left, () =>
        this.leftPart(line, anchor, prefix + String.fromCharCode(A + letter), limit - 1),
      );
      if (play !== null) return play;
    }
    return null;
  }

  /**
   * Extends `prefix` (the word so far, starting at `start`) from the square after it onwards: through
   * tiles already there, and with rack tiles on empty squares that pass their cross-check.
   */
  private extend(
    line: Line,
    anchor: number,
    start: number,
    prefix: string,
  ): readonly Placement[] | null {
    this.step();
    const pos = start + prefix.length;
    const there = pos < this.size ? this.onLine(line, pos) : null;
    if (there !== null) {
      const letter = there.charCodeAt(0) - A;
      if ((this.follows(prefix) & (1 << letter)) === 0) return null;
      return this.extend(line, anchor, start, prefix + there);
    }
    // The word ends here if the anchor is covered, it is at least two letters and in the list.
    if (pos > anchor && prefix.length >= 2 && this.has(prefix)) {
      const play = this.confirm(line, start, prefix);
      /* v8 ignore next -- `confirm` refuses nothing the search finds (see there) */
      if (play !== null) return play;
    }
    if (pos >= this.size || this.left.length + this.right.length >= this.limit) {
      return null;
    }
    const allowed = this.follows(prefix) & this.crossCheck(line, pos) & this.rackMask();
    for (let left = allowed; left !== 0; left &= left - 1) {
      const letter = lowest(left);
      const play = this.withTile(letter, this.right, () =>
        this.extend(line, anchor, start, prefix + String.fromCharCode(A + letter)),
      );
      if (play !== null) return play;
    }
    return null;
  }

  /**
   * The placements of the word just found, if the engine's own rules accept them with every word
   * in the list (words §3.1). The search's checks already ensure it; this keeps the hint and the
   * server in agreement by construction.
   */
  private confirm(line: Line, start: number, word: string): readonly Placement[] | null {
    const puts = [...this.left, ...this.right];
    const placements: Placement[] = [];
    let next = 0;
    for (let i = 0; i < word.length; i += 1) {
      if (this.onLine(line, start + i) !== null) continue;
      const put = at(puts, next);
      next += 1;
      const [row, col] = line.down ? [start + i, line.index] : [line.index, start + i];
      placements.push(
        put.tile === BLANK
          ? { row, col, tile: BLANK, letter: put.letter }
          : { row, col, tile: put.tile },
      );
    }
    const analysis = analysePlay(this.input.ruleset, this.input.board, this.input.rack, placements);
    // A guard only: the search's own checks are these rules, so a play it finds always passes.
    // Were they ever to disagree, the engine's answer wins: a play it refuses is no play, and the
    // search goes on.
    /* v8 ignore start */
    if (isGameError(analysis)) return null;
    return analysis.words.every((scored) => this.input.lexicon.has(scored.word))
      ? placements
      : null;
    /* v8 ignore stop */
  }
}

/** The lowest letter (0 for `a`) set in a non-empty mask. */
function lowest(mask: number): number {
  return 31 - Math.clz32(mask & -mask);
}
