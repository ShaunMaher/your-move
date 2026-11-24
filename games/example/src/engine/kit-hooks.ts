/**
 * The hooks the generic test kit drives the example game with (docs/spec/02-game-framework.md §6).
 * They are part of the contract (02 §2 `test`), so they ship with the engine and stay pure.
 */
import {
  isGameError,
  shuffle,
  type GameTestHooks,
  type RandomSource,
  type Seat,
  type WorstCase,
} from "@your-move/sdk";

import { at } from "./at.js";
import { validateStart } from "./options.js";
import { DECK_SIZE, HAND_SIZE, LIVES, PLAYERS, type Action, type Options } from "./schemas.js";
import { ascending, copyState, playCard, setup, type State } from "./state.js";

/** A card from `seat`'s hand: legal whenever `seat` is to act. */
function randomAction(state: State, seat: Seat, rng: RandomSource): Action {
  const hand = at(state.hands, seat);
  return { card: at(hand, rng.nextInt(hand.length)) };
}

/**
 * A schema-valid action, biased to near-legal: mostly a card in hand, sometimes any card, and
 * sometimes a card already played (this round's own play, or a revealed one).
 */
function randomAnyAction(state: State, seat: Seat, rng: RandomSource): Action {
  const hand = at(state.hands, seat);
  const own = at(state.pending, seat);
  const played = own === null ? state.faceUp : [own, ...state.faceUp];
  const roll = rng.nextInt(10);
  if (roll < 6 && hand.length > 0) return { card: at(hand, rng.nextInt(hand.length)) };
  if (roll < 8 && played.length > 0) return { card: at(played, rng.nextInt(played.length)) };
  return { card: rng.nextInt(DECK_SIZE) + 1 };
}

/**
 * Deals every card `viewer` can't see at random into the same places: the deck (whose order is
 * hidden, discards reshuffled into it included), the face-down discards and, while the game is in progress, the other seats' hands and secret plays (every
 * seat's for the public viewer). Hand sizes and who has played stay the same, and so does every
 * card the viewer can see.
 */
function perturbHidden(state: State, viewer: Seat | null, rng: RandomSource): State {
  const next = copyState(state);
  const inProgress = state.endReason === null;
  const others = state.hands.flatMap((_, seat) => (inProgress && seat !== viewer ? [seat] : []));
  const hidden = [
    ...state.deck,
    ...state.discards,
    ...others.flatMap((seat) => at(state.hands, seat)),
    ...others.flatMap((seat) => {
      const play = at(state.pending, seat);
      return play === null ? [] : [play];
    }),
  ];
  const cards = shuffle(hidden, rng);
  const take = (count: number): number[] => cards.splice(0, count);
  next.deck = take(state.deck.length);
  next.discards = take(state.discards.length);
  for (const seat of others) next.hands[seat] = take(at(state.hands, seat).length).sort(ascending);
  for (const seat of others) {
    if (at(state.pending, seat) !== null) next.pending[seat] = at(take(1), 0);
  }
  return next;
}

/**
 * An upper bound on the transitions in a game. Each is a play or a seat leaving, and a seat leaves
 * at most once. A play ends either revealed, and a revealed card never comes back into play (at
 * most `DECK_SIZE` such plays), or discarded face down unrevealed, which happens to a seat's play
 * only when it leaves or the game ends (at most once per seat). Reshuffled discards can be drawn
 * and played again, but only within this bound, so the game always ends.
 */
function maxActions(_options: Options, seats: number): number {
  return DECK_SIZE + 2 * seats;
}

/**
 * The option inputs the kit plays (02 §6): the defaults, the four corners of the two ranges, and
 * the largest hand the most seats can be dealt, which leaves the deck empty from the start so the
 * first refill after someone leaves reshuffles.
 */
function optionInputs(): readonly unknown[] {
  return [
    {},
    { handSize: HAND_SIZE.min, lives: LIVES.min },
    { handSize: HAND_SIZE.min, lives: LIVES.max },
    { handSize: HAND_SIZE.max, lives: LIVES.min },
    { handSize: HAND_SIZE.max, lives: LIVES.max },
    { handSize: DECK_SIZE / PLAYERS.max },
  ];
}

/**
 * The most expensive inputs for the CPU budget (02 §6.6): the first play of a round; the last play
 * of a round with the most seats, which resolves the round and refills every hand; and that play
 * with the whole deck in the face-down discards, so the refill reshuffles every card left.
 */
function worstCase(
  options: Options,
  seats: number,
  rng: RandomSource,
): readonly WorstCase<State, Action>[] {
  if (isGameError(validateStart(options, seats))) return [];
  const start = setup({ options, seats, rng });
  const last = seats - 1;
  let state = start;
  for (let seat = 0; seat < last; seat += 1) {
    state = playCard(state, seat, at(at(state.hands, seat), 0), rng);
  }
  const reshuffle = copyState(state);
  reshuffle.discards.push(...reshuffle.deck);
  reshuffle.deck = [];
  return [
    { state: start, seat: 0, action: randomAction(start, 0, rng) },
    { state, seat: last, action: randomAction(state, last, rng) },
    { state: reshuffle, seat: last, action: randomAction(reshuffle, last, rng) },
  ];
}

export const testHooks: GameTestHooks<Options, State, Action> = {
  randomAction,
  randomAnyAction,
  perturbHidden,
  hiddenInformation: true,
  maxActions,
  worstCase,
  optionInputs,
};
