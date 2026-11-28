/**
 * The paths game's state and transitions (docs/spec/games/paths.md §2–§5, §7).
 *
 * State is plain JSON data (it is stored as JSON, 02 §5). Transitions never change their input:
 * they copy it with {@link copyState} and change the copy.
 *
 * Random draws: `setup` shuffles the deck, and every transition that returns tiles to the deck
 * (an elimination, resignation or timeout of a player holding tiles) shuffles them in (paths §4).
 * Nothing else draws, and no record shows a tile drawn or returned (02 §6.3).
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
import { edgeNotch } from "./geometry.js";
import { livePosition, movement, type Square } from "./movement.js";
import type {
  EndReason,
  Marker,
  Options,
  Outcome,
  OutReason,
  Phase,
  Placed,
  PublicRecord,
} from "./schemas.js";
import { TILE_COUNT } from "./tiles.js";

/** The full, secret game state (paths §7). */
export interface State {
  readonly options: Options;
  /** The face-down deck; tiles are drawn from the front. */
  deck: number[];
  /** Each seat's hand, ascending tile ids; empty once the seat is out. */
  hands: number[][];
  /** `board[r][c]`: the tile on square `(r, c)`, or null. */
  board: (Placed | null)[][];
  markers: Marker[];
  phase: Phase;
  /** The seat to act; null once the game is over. */
  turn: Seat | null;
  /** Module transitions so far; `out.atAction` orders eliminations (paths §5). */
  moves: number;
  /** Who draws first when tiles return to a drawn-out deck (paths §4). */
  tokenHolder: Seat | null;
  endReason: EndReason | null;
}

/** A deep copy that transitions may change freely. */
export function copyState(state: State): State {
  return {
    ...state,
    deck: [...state.deck],
    hands: state.hands.map((hand) => [...hand]),
    board: state.board.map((row) => row.map((placed) => placed && { ...placed })),
    markers: state.markers.map((marker) => ({
      pos: marker.pos && { ...marker.pos },
      out: marker.out && { ...marker.out },
    })),
  };
}

/** Sorts numbers ascending. */
export const ascending = (a: number, b: number): number => a - b;

/** Shuffles the deck; nobody holds tiles until the marker phase is over (paths §2). */
export function setup(ctx: { options: Options; seats: number; rng: RandomSource }): State {
  const { options, seats, rng } = ctx;
  const size = options.boardSize;
  return {
    options,
    deck: shuffle(
      Array.from({ length: TILE_COUNT }, (_, id) => id),
      rng,
    ),
    hands: Array.from({ length: seats }, () => []),
    board: Array.from({ length: size }, () => Array.from({ length: size }, () => null)),
    markers: Array.from({ length: seats }, () => ({ pos: null, out: null })),
    phase: "markers",
    turn: 0,
    moves: 0,
    tokenHolder: null,
    endReason: null,
  };
}

/** The seat to act, or nobody once the game is over (paths §3 step 7). */
export function toAct(state: State): Seat[] {
  return state.turn === null ? [] : [state.turn];
}

/** `out` once a marker is eliminated, or its player resigned, declined or timed out. */
export function seatStatus(state: State): ("playing" | "out")[] {
  return state.markers.map((marker) => (marker.out === null ? "playing" : "out"));
}

/** Whether `seat` is still in the game. */
function alive(state: State, seat: Seat): boolean {
  return at(state.markers, seat).out === null;
}

/** The seats still in the game, in turn order. */
export function survivors(state: State): Seat[] {
  return state.markers.flatMap((marker, seat) => (marker.out === null ? [seat] : []));
}

/** Whether `seat` is still in the game and holds fewer than `handSize` tiles. */
function short(state: State, seat: Seat): boolean {
  return alive(state, seat) && at(state.hands, seat).length < state.options.handSize;
}

/**
 * The first seat after `from` in turn order, wrapping round (so `from` itself comes last), that
 * passes `test`; null if none does.
 */
function after(state: State, from: Seat, test: (seat: Seat) => boolean): Seat | null {
  const seats = state.markers.length;
  for (let step = 1; step <= seats; step += 1) {
    const seat = (from + step) % seats;
    if (test(seat)) return seat;
  }
  return null;
}

/**
 * Puts `seats` out (paths §3 step 3, §5): their markers leave the board and their hands are
 * returned for the deal. A token holder among them passes the token on (paths §4).
 */
function putOut(
  state: State,
  seats: readonly Seat[],
  reason: OutReason,
  atAction: number,
): number[] {
  const returned: number[] = [];
  for (const seat of seats) {
    state.markers[seat] = { pos: null, out: { atAction, reason } };
    returned.push(...at(state.hands, seat));
    state.hands[seat] = [];
  }
  const holder = state.tokenHolder;
  if (holder !== null && seats.includes(holder)) {
    state.tokenHolder = after(state, holder, (seat) => short(state, seat));
  }
  return returned;
}

/** The mover draws one tile, or takes the token from a drawn-out deck (paths §3 step 5, §4). */
function draw(state: State, seat: Seat): void {
  const tile = state.deck.shift();
  if (tile === undefined) {
    state.tokenHolder ??= seat;
    return;
  }
  const hand = at(state.hands, seat);
  hand.push(tile);
  hand.sort(ascending);
}

/**
 * Shuffles returned tiles into the deck and deals them out at once: one per pass to each short
 * survivor in turn order, from the token holder (or the next survivor after `mover`), until every
 * hand is full or the deck is empty. The token then goes to the next short player after the last
 * one dealt to, or is cleared (paths §4).
 */
function returnTiles(
  state: State,
  returned: readonly number[],
  mover: Seat,
  rng: RandomSource,
): void {
  if (returned.length === 0) return;
  state.deck = shuffle([...state.deck, ...returned], rng);
  const start = state.tokenHolder ?? after(state, mover, (seat) => alive(state, seat));
  if (start === null) {
    state.tokenHolder = null;
    return;
  }
  const seats = state.markers.length;
  const order = Array.from({ length: seats }, (_, step) => (start + step) % seats);
  let last = start;
  while (state.deck.length > 0 && order.some((seat) => short(state, seat))) {
    for (const seat of order) {
      if (state.deck.length > 0 && short(state, seat)) {
        draw(state, seat);
        last = seat;
      }
    }
  }
  state.tokenHolder = after(state, last, (seat) => short(state, seat));
}

/** Ends the game. */
function end(state: State, reason: EndReason): void {
  state.turn = null;
  state.endReason = reason;
}

/**
 * Brings the state to rest after a transition by `from` (paths §3 step 7, §5): ends the game with
 * fewer than two survivors; in the marker phase, moves on to the first survivor without a marker,
 * or starts the tile phase; in the tile phase, passes the turn to the next survivor holding a
 * tile (unless `keepTurn`), skipping those with empty hands, or ends a game nobody can play on.
 * Returns the skipped seats.
 */
function settle(state: State, from: Seat, keepTurn: boolean): Seat[] {
  const left = survivors(state);
  if (left.length === 0) {
    end(state, "wipe-out");
    return [];
  }
  if (left.length === 1) {
    end(state, "last-standing");
    return [];
  }
  if (state.phase === "markers") {
    const next = left.find((seat) => at(state.markers, seat).pos === null);
    if (next !== undefined) {
      state.turn = next;
      return [];
    }
    startTiles(state, left);
    return [];
  }
  if (keepTurn) return [];
  const skipped: Seat[] = [];
  const next = after(state, from, (seat) => {
    if (!alive(state, seat)) return false;
    if (at(state.hands, seat).length > 0) return true;
    skipped.push(seat);
    return false;
  });
  if (next === null) {
    end(state, "board-full");
    return [];
  }
  state.turn = next;
  return skipped;
}

/** Deals a full hand to each survivor in turn order; the first of them plays first (paths §2). */
function startTiles(state: State, left: readonly Seat[]): void {
  state.phase = "tiles";
  for (const seat of left) {
    state.hands[seat] = state.deck.splice(0, state.options.handSize).sort(ascending);
  }
  state.turn = at(left, 0);
}

/** A record's outcome fields with nothing moved, out or skipped. */
function quiet(seat: Seat, skipped: Seat[]): Outcome {
  return { seat, moves: [], eliminated: [], collided: [], skipped };
}

/** The square `seat`'s marker faces; only asked of a seat in the tile phase. */
export function faced(state: State, seat: Seat): Square {
  const pos = livePosition(at(state.markers, seat));
  if (pos === null) throw new Error("the seat has no marker on the board");
  return { r: pos.r, c: pos.c };
}

/** Places `seat`'s marker on edge notch `e` (paths §2 step 3); `validate` has accepted it. */
export function placeMarker(state: State, seat: Seat, e: number): Transition<State, PublicRecord> {
  const next = copyState(state);
  next.moves += 1;
  next.markers[seat] = { pos: edgeNotch(next.options.boardSize, e), out: null };
  const skipped = settle(next, seat, false);
  return { state: next, record: { type: "place-marker", ...quiet(seat, skipped), edgeNotch: e } };
}

/**
 * Plays tile `tileId` at `rotation` on the square `seat`'s marker faces (paths §3); `validate`
 * has accepted it.
 */
export function placeTile(
  state: State,
  seat: Seat,
  placed: Placed,
  rng: RandomSource,
): Transition<State, PublicRecord> {
  const next = copyState(state);
  const atAction = next.moves;
  next.moves += 1;
  const square = faced(next, seat);
  const moved = movement(next.board, next.markers, square, placed);
  at(next.board, square.r)[square.c] = { ...placed };
  next.hands[seat] = at(next.hands, seat).filter((tile) => tile !== placed.tileId);
  moved.moves.forEach(({ seat: mover }, i) => {
    next.markers[mover] = { pos: at(moved.ends, i), out: null };
  });
  const returned = putOut(next, moved.eliminated, "eliminated", atAction);
  if (!moved.eliminated.includes(seat)) draw(next, seat);
  returnTiles(next, returned, seat, rng);
  const skipped = settle(next, seat, false);
  return {
    state: next,
    record: {
      type: "place-tile",
      seat,
      moves: moved.moves,
      eliminated: moved.eliminated,
      collided: moved.collided,
      skipped,
      tileId: placed.tileId,
      rotation: placed.rotation,
      square,
    },
  };
}

/** How a seat leaves the game, by record type, and the reason it is out for. */
const LEAVING: Readonly<Record<"resign" | "decline" | "timeout", OutReason>> = {
  resign: "resigned",
  decline: "declined",
  timeout: "timed_out",
};

/**
 * `seat` resigns, declines or times out (paths §5): its marker is removed, its hand returns to
 * the deck, and play goes on if two or more remain. A seat that is already out, or a game that is
 * over, is left as it is (the framework never asks).
 */
export function leave(
  state: State,
  seat: Seat,
  rng: RandomSource,
  type: keyof typeof LEAVING,
): Transition<State, PublicRecord> {
  const next = copyState(state);
  if (next.endReason !== null || !alive(next, seat)) {
    return { state: next, record: { type, ...quiet(seat, []) } };
  }
  const atAction = next.moves;
  next.moves += 1;
  const theirTurn = next.turn === seat;
  const returned = putOut(next, [seat], LEAVING[type], atAction);
  returnTiles(next, returned, seat, rng);
  const skipped = settle(next, seat, !theirTurn);
  return { state: next, record: { type, ...quiet(seat, skipped) } };
}

/**
 * The final ranking (paths §5, 02 §4): survivors share rank 1; the others rank by elimination
 * order, the most recently out higher, with seats out in the same transition tied (standard
 * competition ranking). With no survivor, the seats out last share rank 1.
 */
export function result(state: State): GameResult | null {
  if (state.endReason === null) return null;
  // Survivors stand above every seat that went out: each `atAction` is below `moves`.
  const standing = (seat: Seat): number => at(state.markers, seat).out?.atAction ?? state.moves;
  const order = state.markers
    .map((_, seat) => seat)
    .sort((a, b) => standing(b) - standing(a) || a - b);
  const ranking: RankingEntry[] = [];
  order.forEach((seat, index) => {
    const previous = ranking[index - 1];
    const tied = previous !== undefined && standing(previous.seat) === standing(seat);
    ranking.push({ seat, rank: tied ? previous.rank : index + 1 });
  });
  return { ranking, endReason: state.endReason };
}
