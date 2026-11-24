/**
 * The words game's state and rules (docs/spec/games/words.md §2–§6, §10.2).
 *
 * State is plain JSON data (it is stored as JSON, 02 §5). Transitions never change their input:
 * they build a new state. The bag is an array whose last element is its top (`swap.ts`).
 *
 * Every rule reads its numbers from the game's ruleset, never from constants (words §8). No
 * transition consults the dictionary: `validate` has already run in the same transition, so replay
 * works without resources (02 §2.1 rule 6).
 */
import {
  isGameError,
  shuffle,
  type ExitReason,
  type GameResult,
  type RandomSource,
  type RankingEntry,
  type Seat,
} from "@your-move/sdk";

import { at } from "./at.js";
import { analysePlay, emptyBoard, inLineOrder, tilePoints, type BoardTile } from "./board.js";
import { findRuleset } from "./rulesets/index.js";
import type { Ruleset } from "./rulesets/schema.js";
import type { EndReason, Options, PlayAction, PublicRecord, SwapAction } from "./schemas.js";
import { draw, removeFromRack, swapTiles } from "./swap.js";

/** How the game ended, and each seat's final-scoring adjustment (words §6). */
interface Finished {
  readonly reason: EndReason;
  readonly adjustments: number[];
  /** The seat that resigned, timed out or declined; null for `out` and `scoreless`. */
  readonly leaver: Seat | null;
}

/** The full, secret game state (words §10.2). */
export interface State {
  readonly options: Options;
  readonly board: (BoardTile | null)[][];
  /** Undrawn tiles; the last one is the top. Its order is secret, even after the game. */
  readonly bag: string[];
  readonly racks: string[][];
  /** Scores; once finished, the final scores with the adjustments applied. */
  readonly scores: number[];
  /** The seat to act. */
  readonly turn: Seat;
  /** Consecutive scoreless turns across all seats (words §5 rule 2). */
  readonly scorelessStreak: number;
  /** The record of the last transition, public (words §10.4). */
  readonly lastMove: PublicRecord | null;
  readonly finished: Finished | null;
}

/** The ruleset a game was started with; a missing one is a bug (options were resolved). */
export function rulesetOf(options: Pick<Options, "rulesetId" | "rulesetVersion">): Ruleset {
  const ruleset = findRuleset(options.rulesetId, options.rulesetVersion);
  if (ruleset === undefined) throw new RangeError("unknown ruleset version");
  return ruleset;
}

/** Every tile of a ruleset, in a fixed order (before shuffling). */
export function allTiles(ruleset: Ruleset): string[] {
  return Object.entries(ruleset.tiles).flatMap(([tile, { count }]) =>
    Array.from({ length: count }, () => tile),
  );
}

/** The total point value of a rack (words §6). */
export function rackValue(ruleset: Ruleset, rack: readonly string[]): number {
  return rack.reduce((sum, tile) => sum + tilePoints(ruleset, tile), 0);
}

/**
 * Shuffles the bag (an unbiased Fisher–Yates shuffle, words §2 rule 1) and deals `rackSize`
 * tiles to every seat in seat order (02 §2 `setup`).
 */
export function setup(ctx: {
  readonly options: Options;
  readonly seats: number;
  readonly rng: RandomSource;
}): State {
  const { options, seats, rng } = ctx;
  const ruleset = rulesetOf(options);
  if (seats * ruleset.rackSize > allTiles(ruleset).length) {
    // validateStart refuses this seat count, so reaching here is a framework bug.
    throw new RangeError("setup: too few tiles to fill every rack");
  }
  let bag = shuffle(allTiles(ruleset), rng);
  const racks: string[][] = [];
  for (let seat = 0; seat < seats; seat += 1) {
    const dealt = draw(bag, ruleset.rackSize);
    racks.push(dealt.drawn);
    bag = dealt.bag;
  }
  return {
    options,
    board: emptyBoard(ruleset),
    bag,
    racks,
    scores: racks.map(() => 0),
    turn: 0,
    scorelessStreak: 0,
    lastMove: null,
    finished: null,
  };
}

/** The seat to act, or nobody once the game is over (02 §2.3). */
export function toAct(state: State): Seat[] {
  return state.finished === null ? [state.turn] : [];
}

/** Every seat plays until the end; a seat that resigned, timed out or declined is out (02 §4). */
export function seatStatus(state: State): ("playing" | "out")[] {
  return state.racks.map((_, seat) => (state.finished?.leaver === seat ? "out" : "playing"));
}

/** The rack held by a seat; a seat that doesn't exist is a bug. */
export function rackOf(state: State, seat: Seat): string[] {
  return at(state.racks, seat);
}

/** A copy of `items` with item `index` replaced. */
function replaced<T>(items: readonly T[], index: number, item: T): T[] {
  return items.map((old, i) => (i === index ? item : old));
}

/**
 * Plays tiles (words §3.1, §4): the play was validated, so its placements are legal. The player
 * scores, draws back up to `rackSize` (or as many as the bag holds), and the game ends if they
 * went out with the bag empty or the scoreless streak reached its limit (words §5).
 */
export function playTiles(
  state: State,
  seat: Seat,
  action: PlayAction,
): { state: State; record: PublicRecord } {
  const ruleset = rulesetOf(state.options);
  const rack = rackOf(state, seat);
  const analysis = analysePlay(ruleset, state.board, rack, action.placements);
  if (isGameError(analysis)) throw new RangeError("apply precondition: the play isn't legal");
  const board = state.board.map((row) => [...row]);
  const placements = inLineOrder(action.placements).map((p) => ({
    row: p.row,
    col: p.col,
    tile: p.tile,
    letter: p.letter ?? p.tile,
  }));
  for (const p of placements) at(board, p.row)[p.col] = { tile: p.tile, letter: p.letter };
  const kept = removeFromRack(
    rack,
    placements.map((p) => p.tile),
  );
  const refill = draw(state.bag, ruleset.rackSize - kept.length);
  const record: PublicRecord = {
    seat,
    type: "play",
    placements,
    words: [...analysis.words],
    score: analysis.score,
    bingo: analysis.bingo,
  };
  const next: State = {
    ...state,
    board,
    bag: refill.bag,
    racks: replaced(state.racks, seat, [...kept, ...refill.drawn]),
    scores: replaced(state.scores, seat, at(state.scores, seat) + analysis.score),
    scorelessStreak: analysis.score === 0 ? state.scorelessStreak + 1 : 0,
    lastMove: record,
  };
  const wentOut = next.bag.length === 0 && rackOf(next, seat).length === 0;
  return { state: endTurn(next, seat, wentOut ? "out" : null), record };
}

/** Swaps tiles with the bag in the ruleset's `swapOrder` (words §3.2); scores 0. */
export function swap(
  state: State,
  seat: Seat,
  action: SwapAction,
  rng: RandomSource,
): { state: State; record: PublicRecord } {
  const ruleset = rulesetOf(state.options);
  const swapped = swapTiles(rackOf(state, seat), state.bag, action.tiles, ruleset.swapOrder, rng);
  const record: PublicRecord = {
    seat,
    type: "swap",
    score: 0,
    bingo: false,
    swapCount: action.tiles.length,
  };
  const next: State = {
    ...state,
    bag: swapped.bag,
    racks: replaced(state.racks, seat, swapped.rack),
    scorelessStreak: state.scorelessStreak + 1,
    lastMove: record,
  };
  return { state: endTurn(next, seat, null), record };
}

/** Passes (words §3.3); scores 0. */
export function pass(state: State, seat: Seat): { state: State; record: PublicRecord } {
  const record: PublicRecord = { seat, type: "pass", score: 0, bingo: false };
  const next: State = { ...state, scorelessStreak: state.scorelessStreak + 1, lastMove: record };
  return { state: endTurn(next, seat, null), record };
}

/**
 * A seat leaves (words §3.4, §5, §10.6): the game ends at once with scores frozen and the other
 * player wins. Rulesets allow two seats only (words §8.2), because multi-player resignation isn't
 * specified yet; a game with more seats, or one already over, is a precondition failure (the
 * framework never calls a finished game's `onResign`/`onTimeout`), so it throws (02 §2.1 rule 3).
 */
export function leave(
  state: State,
  seat: Seat,
  how: ExitReason | "timeout",
): { state: State; record: PublicRecord } {
  if (state.racks.length !== 2) throw new RangeError("leave: only 2-seat games are specified");
  if (state.finished !== null) throw new RangeError("leave: the game is already over");
  const record: PublicRecord = { seat, type: how, score: 0, bingo: false };
  const finished: Finished = {
    reason: how,
    adjustments: state.scores.map(() => 0),
    leaver: seat,
  };
  return { state: { ...state, lastMove: record, finished }, record };
}

/**
 * Ends `seat`'s turn: the game ends as `out` if the seat just went out, or as `scoreless` if the
 * streak reached the ruleset's limit; otherwise the next seat is to act.
 */
function endTurn(state: State, seat: Seat, ending: "out" | null): State {
  const ruleset = rulesetOf(state.options);
  if (ending === "out") return finish(state, ruleset, "out", seat);
  if (state.scorelessStreak >= ruleset.scorelessTurnLimit) {
    return finish(state, ruleset, "scoreless", null);
  }
  return { ...state, turn: (seat + 1) % state.racks.length };
}

/**
 * Final scoring (words §6). Out: the player who went out gains the value of every other rack,
 * and each other player loses their own. Scoreless: everyone loses their own rack's value.
 */
function finish(
  state: State,
  ruleset: Ruleset,
  reason: "out" | "scoreless",
  wentOut: Seat | null,
): State {
  const values = state.racks.map((rack) => rackValue(ruleset, rack));
  const others = values.reduce((sum, value) => sum + value, 0);
  const adjustments = values.map((value, seat) => (seat === wentOut ? others : -value));
  return {
    ...state,
    scores: state.scores.map((score, seat) => score + at(adjustments, seat)),
    finished: { reason, adjustments, leaver: null },
  };
}

/**
 * The result (words §6, §10.6): standard competition ranking by final score, ties sharing a
 * rank. A seat that resigned, timed out or declined ranks last whatever its score; the others are
 * ranked by score among themselves.
 */
export function result(state: State): GameResult | null {
  const { finished } = state;
  if (finished === null) return null;
  const seats = state.scores.map((score, seat) => ({ seat, score }));
  const ranked = seats
    .filter(({ seat }) => seat !== finished.leaver)
    .sort((a, b) => b.score - a.score || a.seat - b.seat);
  // A seat's rank is one more than the number of seats with a higher score.
  const ranking: RankingEntry[] = ranked.map(({ seat, score }) => ({
    seat,
    rank: 1 + ranked.filter((other) => other.score > score).length,
    score,
  }));
  if (finished.leaver !== null) {
    const score = at(state.scores, finished.leaver);
    ranking.push({ seat: finished.leaver, rank: ranking.length + 1, score });
  }
  return { ranking, endReason: finished.reason };
}
