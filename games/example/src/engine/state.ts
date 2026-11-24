/**
 * The example game's state and rules (docs/spec/02-game-framework.md §2, §2.3, §4, §7.6).
 *
 * Every round is one simultaneous secret phase: each playing seat plays one card face down, in any
 * order (02 §2.3). When the last one has played, the cards are revealed: the highest card scores a
 * point and the lowest loses a life, and a seat with no lives left is out. Revealed cards stay out
 * of play for good. If the deck can't give every playing seat a card, the face-down discards (the
 * cards of seats that left) are shuffled into it; then, if it can, each playing seat draws one, so
 * the playing seats always hold equally many cards. The game ends when at most one seat is playing
 * or the playing seats' hands are empty.
 *
 * The reshuffle is the only random draw after `setup`, so the example exercises per-transition
 * draws (02 §2.1 rule 2, §5) without ever letting a draw reach a record (§6.3).
 *
 * State is plain JSON data (it is stored as JSON, 02 §5). Transitions never change their input:
 * they copy it with {@link copyState} and change the copy.
 */
import {
  shuffle,
  type GameResult,
  type RandomSource,
  type RankingEntry,
  type Seat,
} from "@your-move/sdk";

import { at } from "./at.js";
import { DECK_SIZE, type EndReason, type LastRound, type Options } from "./schemas.js";

/** The full, secret game state. */
export interface State {
  readonly options: Options;
  /** The current round, from 1. */
  round: number;
  /** The face-down draw pile; cards are drawn from the front. */
  deck: number[];
  /** Each seat's hand, sorted ascending; empty once the seat is out. */
  hands: number[][];
  /** Each seat's secret play this round, or null if it hasn't played. */
  pending: (number | null)[];
  lives: number[];
  points: number[];
  status: ("playing" | "out")[];
  /** Seats in the order they went out, for the ranking. */
  outOrder: Seat[];
  /** Face-down cards out of play: the cards of seats that left, and plays left at the end. */
  discards: number[];
  /** Every card revealed in a resolved round. */
  faceUp: number[];
  lastRound: LastRound | null;
  endReason: EndReason | null;
}

/** A deep copy that transitions may change freely. */
export function copyState(state: State): State {
  return {
    ...state,
    deck: [...state.deck],
    hands: state.hands.map((hand) => [...hand]),
    pending: [...state.pending],
    lives: [...state.lives],
    points: [...state.points],
    status: [...state.status],
    outOrder: [...state.outOrder],
    discards: [...state.discards],
    faceUp: [...state.faceUp],
    lastRound: state.lastRound && {
      ...state.lastRound,
      plays: state.lastRound.plays.map((play) => ({ ...play })),
    },
  };
}

/** Sorts numbers ascending. */
export const ascending = (a: number, b: number): number => a - b;

/** Shuffles the deck and deals a hand to every seat, in seat order (02 §2 `setup`). */
export function setup(ctx: { options: Options; seats: number; rng: RandomSource }): State {
  const { options, seats, rng } = ctx;
  if (seats * options.handSize > DECK_SIZE) {
    // validateStart refuses this seat count, so reaching here is a framework bug.
    throw new RangeError("setup: the deck can't deal a full hand to every seat");
  }
  const deck = shuffle(
    Array.from({ length: DECK_SIZE }, (_, i) => i + 1),
    rng,
  );
  const hands = Array.from({ length: seats }, () =>
    deck.splice(0, options.handSize).sort(ascending),
  );
  return {
    options,
    round: 1,
    deck,
    hands,
    pending: hands.map(() => null),
    lives: hands.map(() => options.lives),
    points: hands.map(() => 0),
    status: hands.map(() => "playing"),
    outOrder: [],
    discards: [],
    faceUp: [],
    lastRound: null,
    endReason: null,
  };
}

/** The seats still in the game, in seat order. */
export function playingSeats(state: State): Seat[] {
  return state.status.flatMap((status, seat) => (status === "playing" ? [seat] : []));
}

/** Every playing seat that hasn't played this round; nobody once the game is over (02 §2.3). */
export function toAct(state: State): Seat[] {
  if (state.endReason !== null) return [];
  return playingSeats(state).filter((seat) => state.pending[seat] === null);
}

/**
 * Plays `card` from `seat`'s hand face down; the last play of a round resolves it. `rng` is drawn
 * from only if the refill needs a reshuffle.
 */
export function playCard(state: State, seat: Seat, card: number, rng: RandomSource): State {
  const next = copyState(state);
  next.hands[seat] = at(next.hands, seat).filter((held) => held !== card);
  next.pending[seat] = card;
  settle(next, rng);
  return next;
}

/**
 * Takes `seat` out of the game (resigned, declined or timed out): its hand and any secret play
 * this round are discarded face down. If everyone left has already played, the round resolves.
 */
export function removeSeat(state: State, seat: Seat, rng: RandomSource): State {
  const next = copyState(state);
  if (next.endReason !== null || next.status[seat] !== "playing") return next;
  knockOut(next, seat);
  settle(next, rng);
  return next;
}

/** Marks `seat` out and discards its cards face down. */
function knockOut(state: State, seat: Seat): void {
  state.status[seat] = "out";
  state.outOrder.push(seat);
  state.discards.push(...at(state.hands, seat));
  state.hands[seat] = [];
  discardPending(state);
}

/**
 * Brings the state to rest after a play or an exit: ends the game if at most one seat is left;
 * otherwise, once every playing seat has played, resolves the round and refills the hands,
 * reshuffling the discards into a deck too small to give every playing seat a card.
 */
function settle(state: State, rng: RandomSource): void {
  if (playingSeats(state).length > 1) {
    if (toAct(state).length > 0) return;
    resolveRound(state);
  }
  const playing = playingSeats(state);
  if (playing.length <= 1) {
    end(state, "last-standing");
    return;
  }
  if (state.deck.length < playing.length && state.discards.length > 0) {
    // The deck order is hidden, so the discards go in shuffled together with what is left.
    state.deck = shuffle([...state.deck, ...state.discards], rng);
    state.discards = [];
  }
  if (state.deck.length >= playing.length) {
    for (const seat of playing) {
      const hand = at(state.hands, seat);
      hand.push(...state.deck.splice(0, 1));
      hand.sort(ascending);
    }
  }
  if (playing.every((seat) => at(state.hands, seat).length === 0)) end(state, "cards-exhausted");
}

/** Reveals every secret play: the highest card scores a point, the lowest loses a life. */
function resolveRound(state: State): void {
  const plays = playingSeats(state).flatMap((seat) => {
    const card = at(state.pending, seat);
    return card === null ? [] : [{ seat, card }];
  });
  const byCard = [...plays].sort((a, b) => a.card - b.card);
  const low = at(byCard, 0).seat;
  const high = at(byCard, byCard.length - 1).seat;
  state.faceUp.push(...plays.map((play) => play.card));
  state.pending = state.pending.map(() => null);
  state.points[high] = at(state.points, high) + 1;
  state.lives[low] = at(state.lives, low) - 1;
  const eliminated = state.lives[low] === 0 ? low : null;
  if (eliminated !== null) knockOut(state, eliminated);
  state.lastRound = { round: state.round, plays, high, low, eliminated };
  state.round += 1;
}

/** Ends the game; plays still face down stay hidden for good. */
function end(state: State, reason: EndReason): void {
  state.endReason = reason;
  discardPending(state);
}

/** Moves the secret plays of seats no longer playing (or of everyone, at the end) to discards. */
function discardPending(state: State): void {
  state.pending = state.pending.map((play, seat) => {
    if (play === null || (state.status[seat] === "playing" && state.endReason === null)) {
      return play;
    }
    state.discards.push(play);
    return null;
  });
}

/**
 * The final ranking (02 §2 `result`, §4): seats still playing first, by lives then points, with
 * standard competition ranking for ties (1, 2, 2, 4); then the seats that went out, the latest
 * first. Each entry's score is its points.
 */
export function result(state: State): GameResult | null {
  if (state.endReason === null) return null;
  const survivors = playingSeats(state).sort((a, b) => standing(state, b) - standing(state, a));
  const ranking: RankingEntry[] = [];
  survivors.forEach((seat, index) => {
    const previous = ranking[index - 1];
    const tied = previous !== undefined && standing(state, previous.seat) === standing(state, seat);
    ranking.push({ seat, rank: tied ? previous.rank : index + 1, score: at(state.points, seat) });
  });
  for (const seat of [...state.outOrder].reverse()) {
    ranking.push({ seat, rank: ranking.length + 1, score: at(state.points, seat) });
  }
  return { ranking, endReason: state.endReason };
}

/** A survivor's standing as one number: lives first, then points. */
function standing(state: State, seat: Seat): number {
  return at(state.lives, seat) * (DECK_SIZE + 1) + at(state.points, seat);
}
