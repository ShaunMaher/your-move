/**
 * The pairs game's state and transitions (docs/spec/games/pairs.md §2–§6, §8.1, §8.2).
 *
 * State is plain JSON data (it is stored as JSON, 02 §5). Transitions never change their input:
 * they copy it with {@link copyState} and change the copy.
 *
 * Random draws: only `setup` draws, to choose the faces in play and to lay them out (pairs §2).
 */
import {
  shuffle,
  type GameResult,
  type RandomSource,
  type RankingEntry,
  type Seat,
  type Transition,
} from "@your-move/sdk";

import { at } from "./at.js";
import {
  FACE_COUNT,
  gridOf,
  type EndReason,
  type Grid,
  type Options,
  type OutReason,
  type PublicRecord,
} from "./schemas.js";

/** When and why a seat left; `atMove` is `moves` before the transition that put it out. */
export interface Out {
  readonly atMove: number;
  readonly reason: OutReason;
}

/** The previous turn's unmatched pair while it is shown, in the order turned (pairs §4). */
export interface LastMiss {
  readonly seat: Seat;
  readonly cards: readonly [number, number];
}

/** The full, secret game state (pairs §8.1), keys in this order. */
export interface State {
  readonly options: Options;
  /** The layout: the face on each card, by card index (reading order). */
  faces: number[];
  /** By card index: the seat that found its pair, or null. */
  matchedBy: (Seat | null)[];
  /** The card index of the turn's first card while it is up. */
  turned: number | null;
  lastMiss: LastMiss | null;
  /** The seat to act; null once the game is over. */
  turn: Seat | null;
  /** By seat: null while it plays. */
  out: (Out | null)[];
  /** Module transitions so far: every card turned and every leave. */
  moves: number;
  endReason: EndReason | null;
}

/**
 * A copy that transitions may change freely: its arrays are new, and the `lastMiss` and `out`
 * entries it shares are read-only (transitions replace them, never change them).
 */
function copyState(state: State): State {
  return {
    ...state,
    faces: [...state.faces],
    matchedBy: [...state.matchedBy],
    out: [...state.out],
  };
}

/** The grid a state is played on. */
export const gridFor = (state: State): Grid => gridOf(state.options.grid);

/**
 * Chooses the faces in play and lays them out (pairs §2): the 18 ids are shuffled on every grid
 * and the first `pairs` kept; the deck is those faces ascending, each twice, shuffled into
 * card-index order. Seat 0 turns first.
 */
export function setup(ctx: { options: Options; seats: number; rng: RandomSource }): State {
  const { options, seats, rng } = ctx;
  const { pairs } = gridOf(options.grid);
  const ids = Array.from({ length: FACE_COUNT }, (_, id) => id);
  const inPlay = shuffle(ids, rng)
    .slice(0, pairs)
    .sort((a, b) => a - b);
  const deck = inPlay.flatMap((face) => [face, face]);
  return {
    options,
    faces: shuffle(deck, rng),
    matchedBy: deck.map(() => null),
    turned: null,
    lastMiss: null,
    turn: 0,
    out: Array.from({ length: seats }, () => null),
    moves: 0,
    endReason: null,
  };
}

/** The seat to act, or nobody once the game is over (pairs §8.2). */
export function toAct(state: State): Seat[] {
  return state.turn === null ? [] : [state.turn];
}

/** The seat to act; only asked while the game is in progress. */
export function seatToAct(state: State): Seat {
  if (state.turn === null) throw new Error("the game is over");
  return state.turn;
}

/** `out` once the seat resigned, timed out or declined; nobody is eliminated by the rules. */
export function seatStatus(state: State): ("playing" | "out")[] {
  return state.out.map((out) => (out === null ? "playing" : "out"));
}

/** The seats still playing, in seat order. */
function playing(state: State): Seat[] {
  return state.out.flatMap((out, seat) => (out === null ? [seat] : []));
}

/** Pairs found, by seat. */
export function pairsFound(state: State): number[] {
  const found = state.out.map(() => 0);
  for (const seat of state.matchedBy) {
    if (seat !== null) found[seat] = at(found, seat) + 1;
  }
  return found.map((cards) => cards / 2);
}

/** The pairs not yet found. */
export function pairsLeft(state: State): number {
  return state.matchedBy.filter((seat) => seat === null).length / 2;
}

/** The first seat after `from` in turn order that is still playing, wrapping round. */
function nextPlaying(state: State, from: Seat): Seat {
  const seats = state.out.length;
  for (let step = 1; step < seats; step += 1) {
    const seat = (from + step) % seats;
    if (at(state.out, seat) === null) return seat;
  }
  throw new Error("no other seat is still playing");
}

/** Whether the move limit `4 × pairs²` is reached (pairs §6). */
const atLimit = (state: State): boolean => state.moves >= gridFor(state).moveLimit;

/** Ends the game: nothing stays turned (pairs §6, §8.2). */
function end(state: State, reason: EndReason): void {
  state.endReason = reason;
  state.turn = null;
  state.turned = null;
  state.lastMiss = null;
}

/**
 * `seat`, the seat to act, turns over card `card` (pairs §3, §8.2); `validate` has accepted it.
 * Exactly one branch applies: a first card, a second card that matches, or one that misses.
 */
export function flip(state: State, seat: Seat, card: number): Transition<State, PublicRecord> {
  const next = copyState(state);
  next.moves += 1;
  const first = next.turned;
  if (first === null) {
    next.lastMiss = null;
    next.turned = card;
    return { state: next, record: { type: "flip", seat, step: 1 } };
  }
  next.turned = null;
  if (at(next.faces, card) === at(next.faces, first)) {
    next.matchedBy[first] = seat;
    next.matchedBy[card] = seat;
    if (next.matchedBy.every((by) => by !== null)) end(next, "all-found");
    else if (atLimit(next)) end(next, "move-limit");
  } else {
    next.lastMiss = { seat, cards: [first, card] };
    if (atLimit(next)) end(next, "move-limit");
    else next.turn = nextPlaying(next, seat);
  }
  return { state: next, record: { type: "flip", seat, step: 2 } };
}

/** How a seat leaves, by record type, and the reason it is out for (pairs §8.2). */
const LEAVING: Readonly<Record<"resign" | "decline" | "timeout", OutReason>> = {
  resign: "resigned",
  decline: "declined",
  timeout: "timed_out",
};

/**
 * `seat` resigns, declines or times out (pairs §5, §8.2): it is out and keeps its pairs; mid-turn
 * its first card turns back face down, and a `missed` pair still shown stays shown. A seat that is
 * already out, or a game that is over, is left as it is (the framework never asks).
 */
export function leave(
  state: State,
  seat: Seat,
  type: keyof typeof LEAVING,
): Transition<State, PublicRecord> {
  const next = copyState(state);
  const record: PublicRecord = { type, seat };
  if (next.endReason !== null || at(next.out, seat) !== null) return { state: next, record };
  const theirTurn = next.turn === seat;
  next.out[seat] = { atMove: next.moves, reason: LEAVING[type] };
  next.moves += 1;
  if (theirTurn) next.turned = null;
  if (playing(next).length === 1) end(next, "last-standing");
  else if (theirTurn && atLimit(next)) end(next, "move-limit");
  else if (theirTurn) next.turn = nextPlaying(next, seat);
  return { state: next, record };
}

/**
 * The final ranking (pairs §6, 02 §4): seats still playing by pairs found, most first, ties
 * sharing a rank; then the seats that left, the most recent leaver highest (one seat leaves per
 * transition, so they never tie). Every seat's score is its pairs found.
 */
export function result(state: State): GameResult | null {
  if (state.endReason === null) return null;
  const found = pairsFound(state);
  // Seats still playing stand above every leaver: each `atMove` is below `moves`, and pairs found
  // are offset by `moves + 1`.
  const standing = (seat: Seat): number =>
    at(state.out, seat)?.atMove ?? state.moves + 1 + at(found, seat);
  const order = state.out.map((_, seat) => seat).sort((a, b) => standing(b) - standing(a) || a - b);
  const ranking: RankingEntry[] = [];
  order.forEach((seat, index) => {
    const previous = ranking[index - 1];
    const tied = previous !== undefined && standing(previous.seat) === standing(seat);
    ranking.push({ seat, rank: tied ? previous.rank : index + 1, score: at(found, seat) });
  });
  return { ranking, endReason: state.endReason };
}
