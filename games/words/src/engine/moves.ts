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

/** The most steps one action of the search takes (an extension: itself, a lookup, a prefix). */
export const MAX_STEPS_PER_ACTION = 3;

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
  /**
   * Searches on for `steps` more steps (at most `MAX_STEPS_PER_ACTION - 1` over, since one action
   * of the search is never split): the outcome once known, else null.
   */
  advance(steps: number): SearchOutcome | null;
  /** The steps used so far. */
  readonly steps: number;
  /**
   * Plays the search built that the engine's own rules then refused (see `confirm`): always 0,
   * because the search's checks are those rules; tests pin it.
   */
  readonly refused: number;
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

/** The tile put down to reach a frame, to take back when the frame is done. */
interface Undo {
  readonly letter: number;
  readonly real: boolean;
  readonly into: Put[];
}

/**
 * One node of the search, kept on an explicit stack so a slice can stop anywhere and the next one
 * go on: a *left part* (tiles before the anchor, then extended rightwards) or an *extension* (the
 * word from `start`, growing through tiles on the board and rack tiles on empty squares).
 */
interface Frame {
  readonly kind: "left" | "extend";
  /** The word so far; an extension grows it in place through tiles already on the board. */
  prefix: string;
  /** Extension: where the word starts. Left part: how many more tiles may go before the anchor. */
  readonly start: number;
  readonly limit: number;
  /** 0: not entered; 1 (left part): its own extension is done; 2: trying `letters`. */
  phase: 0 | 1 | 2;
  /** The letters still to try here, as a mask. */
  letters: number;
  readonly undo: Undo | null;
}

/** Where the cross-checks of one direction have got to: square by square, letter by letter. */
interface CrossChecks {
  readonly down: boolean;
  readonly masks: number[];
  /** The next square to look at, as `row * size + col`. */
  next: number;
  /** The square being checked, if any: the words either side of it and the letters to try. */
  square: number;
  before: string;
  after: string;
  letters: number;
  mask: number;
}

/** Thrown out of the search when it runs past its step limit. */
class OutOfSteps extends Error {}

/** Starts a search; nothing runs until `advance`. */
export function searchPlays(input: SearchInput): PlaySearch {
  return new Search(input);
}

class Search implements PlaySearch {
  steps = 0;
  refused = 0;
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
  /** Cross-check masks per direction (`down` ? 1 : 0), by `row * size + col`; ALL off a line. */
  private readonly crossChecks: [number[], number[]] = [[], []];
  /** `follows` answers already asked: prefixes repeat across anchors. */
  private readonly followsCache = new Map<string, number>();
  /** The tiles of the left part and of the right part of the play being built. */
  private readonly left: Put[] = [];
  private readonly right: Put[] = [];
  /** The unit under way: cross-checks being found, or an anchor's frames. */
  private cross: CrossChecks | null = null;
  private readonly stack: Frame[] = [];
  private line: Line = { down: false, index: 0 };
  private anchor = 0;
  /** The most tiles the plays of the anchor under way may use. */
  private limit = 0;

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
      for (;;) {
        if (this.cross === null && this.stack.length === 0) {
          if (this.next >= this.units.length) return (this.outcome = { kind: "none" });
          this.begin(at(this.units, this.next));
          this.next += 1;
        }
        if (this.steps >= until) return null;
        const play = this.cross === null ? this.act() : this.crossAct(this.cross);
        if (play !== null) return (this.outcome = { kind: "some", play });
      }
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
        if (this.touches(row, col)) found.push([row, col]);
      }
    }
    return found;
  }

  private touches(row: number, col: number): boolean {
    return (
      this.letterAt(row - 1, col) !== null ||
      this.letterAt(row + 1, col) !== null ||
      this.letterAt(row, col - 1) !== null ||
      this.letterAt(row, col + 1) !== null
    );
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
    return this.touches(row, col);
  }

  /** Starts a unit: the cross-checks of a direction, or the first frame of an anchor's plays. */
  private begin(unit: Unit): void {
    if (unit.kind === "crossChecks") {
      const masks = new Array<number>(this.size * this.size).fill(ALL_LETTERS);
      this.cross = {
        down: unit.down,
        masks,
        next: 0,
        square: -1,
        before: "",
        after: "",
        letters: 0,
        mask: 0,
      };
      return;
    }
    const { line, pos: anchor } = unit;
    this.line = line;
    this.anchor = anchor;
    this.limit = unit.tiles;
    // Tiles just before the anchor are the fixed start of every word through it.
    let start = anchor;
    let prefix = "";
    for (let l = this.onLine(line, start - 1); l !== null; l = this.onLine(line, start - 1)) {
      prefix = l + prefix;
      start -= 1;
    }
    if (start < anchor) {
      this.push("extend", prefix, start, 0, null);
      return;
    }
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
    this.push("left", "", 0, limit, null);
  }

  private push(
    kind: Frame["kind"],
    prefix: string,
    start: number,
    limit: number,
    undo: Undo | null,
  ): void {
    this.stack.push({ kind, prefix, start, limit, phase: 0, letters: 0, undo });
  }

  /** Leaves the top frame, taking back the tile that led to it. */
  private pop(): null {
    const frame = this.stack.pop();
    const undo = frame?.undo;
    if (undo !== undefined && undo !== null) {
      undo.into.pop();
      if (undo.real) this.counts[undo.letter] = at(this.counts, undo.letter) + 1;
      else this.blanks += 1;
    }
    return null;
  }

  /**
   * Puts down a tile showing `letter` (a real tile when the rack has one, else a blank) and
   * returns how to take it back. A real tile is never worse than a blank for the rest of the play,
   * so the blank is used only for a letter the rack lacks.
   */
  private put(letter: number, into: Put[]): Undo {
    const shown = String.fromCharCode(A + letter);
    const real = at(this.counts, letter) > 0;
    if (real) this.counts[letter] = at(this.counts, letter) - 1;
    else this.blanks -= 1;
    into.push({ tile: real ? shown : BLANK, letter: shown });
    return { letter, real, into };
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

  /** One action on the top frame (at most `MAX_STEPS_PER_ACTION` steps): a play, or null. */
  private act(): readonly Placement[] | null {
    const frame = at(this.stack, this.stack.length - 1);
    if (frame.kind === "left") return this.actLeft(frame);
    return this.actExtend(frame);
  }

  /** A left part: its own extension from the anchor, then each next tile before the anchor. */
  private actLeft(frame: Frame): null {
    if (frame.phase === 0) {
      this.step();
      frame.phase = 1;
      this.push("extend", frame.prefix, this.anchor - frame.prefix.length, 0, null);
      return null;
    }
    if (frame.phase === 1) {
      if (frame.limit === 0) return this.pop();
      frame.letters = this.follows(frame.prefix) & this.rackMask();
      frame.phase = 2;
      return null;
    }
    if (frame.letters === 0) return this.pop();
    const letter = lowest(frame.letters);
    frame.letters &= frame.letters - 1;
    const undo = this.put(letter, this.left);
    this.push("left", frame.prefix + String.fromCharCode(A + letter), 0, frame.limit - 1, undo);
    return null;
  }

  /**
   * An extension: through a tile already on the board, or, on an empty square, the word may end
   * here (if the anchor is covered and it is a word of two letters or more) and each rack tile
   * that passes the square's cross-check may go on.
   */
  private actExtend(frame: Frame): readonly Placement[] | null {
    if (frame.phase === 2) {
      if (frame.letters === 0) return this.pop();
      const letter = lowest(frame.letters);
      frame.letters &= frame.letters - 1;
      const undo = this.put(letter, this.right);
      this.push("extend", frame.prefix + String.fromCharCode(A + letter), frame.start, 0, undo);
      return null;
    }
    this.step();
    const { line, anchor } = this;
    const pos = frame.start + frame.prefix.length;
    const there = pos < this.size ? this.onLine(line, pos) : null;
    if (there !== null) {
      const letter = there.charCodeAt(0) - A;
      if ((this.follows(frame.prefix) & (1 << letter)) === 0) return this.pop();
      frame.prefix += there;
      return null;
    }
    if (pos > anchor && frame.prefix.length >= 2 && this.has(frame.prefix)) {
      const play = this.confirm(line, frame.start, frame.prefix);
      /* v8 ignore next -- `confirm` refuses nothing the search finds (see there) */
      if (play !== null) return play;
    }
    if (pos >= this.size || this.left.length + this.right.length >= this.limit) return this.pop();
    frame.letters = this.follows(frame.prefix) & this.crossCheck(line, pos) & this.rackMask();
    frame.phase = 2;
    return null;
  }

  /**
   * One action of finding cross-checks: for plays along `down`, the letters each empty square may
   * take so the word across the line through it (if it touches tiles that way) is in the list.
   * Each action looks at one more square (one prefix question) or tries one more letter there.
   */
  private crossAct(cross: CrossChecks): null {
    if (cross.square >= 0) {
      if (cross.letters === 0) {
        cross.masks[cross.square] = cross.mask;
        cross.square = -1;
        return null;
      }
      const letter = lowest(cross.letters);
      cross.letters &= cross.letters - 1;
      if (this.has(cross.before + String.fromCharCode(A + letter) + cross.after)) {
        cross.mask |= 1 << letter;
      }
      return null;
    }
    // The cross-word runs across the play line: along a row for a play down a column.
    const [dr, dc] = cross.down ? [0, 1] : [1, 0];
    for (; cross.next < this.size * this.size; cross.next += 1) {
      const [row, col] = [Math.floor(cross.next / this.size), cross.next % this.size];
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
      Object.assign(cross, { square: cross.next, before, after, mask: 0 });
      cross.letters = this.follows(before);
      cross.next += 1;
      return null;
    }
    this.crossChecks[cross.down ? 1 : 0] = cross.masks;
    this.cross = null;
    return null;
  }

  private crossCheck(line: Line, pos: number): number {
    const [row, col] = line.down ? [pos, line.index] : [line.index, pos];
    return this.crossChecks[line.down ? 1 : 0][row * this.size + col] ?? ALL_LETTERS;
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
    if (isGameError(analysis) || !analysis.words.every((w) => this.input.lexicon.has(w.word))) {
      this.refused += 1;
      return null;
    }
    /* v8 ignore stop */
    return placements;
  }
}

/** The lowest letter (0 for `a`) set in a non-empty mask. */
function lowest(mask: number): number {
  return 31 - Math.clz32(mask & -mask);
}
