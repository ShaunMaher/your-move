/**
 * The hooks the generic test kit drives the paths game with (docs/spec/02-game-framework.md §6,
 * docs/spec/games/paths.md §7). They are part of the contract (02 §2 `test`), so they ship with
 * the engine and stay pure.
 */
import {
  shuffle,
  type GameTestHooks,
  type RandomSource,
  type Seat,
  type WorstCase,
} from "@your-move/sdk";

import { ascending, at } from "./at.js";
import { edgeNotchCount } from "./geometry.js";
import { movement } from "./movement.js";
import { freeEdgeNotches, legalPlacements } from "./rules.js";
import { HAND_SIZE, type Action, type Options, type Placed } from "./schemas.js";
import { copyState, faced, placeMarker, placeTile, setup, type State } from "./state.js";
import { ROTATIONS, TILE_COUNT } from "./tiles.js";

/** One of `items`, chosen with `rng`. */
function pick<T>(items: readonly T[], rng: RandomSource): T {
  return at(items, rng.nextInt(items.length));
}

/** A tile action from a placement. */
function tileAction(placed: Placed): Action {
  return { type: "place-tile", tileId: placed.tileId, rotation: placed.rotation };
}

/** A legal action for `seat`, which is to act: a free edge notch, or a legal placement. */
function randomAction(state: State, seat: Seat, rng: RandomSource): Action {
  if (state.phase === "markers") {
    return { type: "place-marker", edgeNotch: pick(freeEdgeNotches(state), rng) };
  }
  return tileAction(pick(legalPlacements(state, seat), rng));
}

/**
 * A schema-valid action, biased to near-legal: mostly the right kind, with an edge notch that may
 * be taken or off the board, or a tile that may not be in hand or may put the mover out; and now
 * and then the other phase's kind.
 */
function randomAnyAction(state: State, seat: Seat, rng: RandomSource): Action {
  const roll = rng.nextInt(10);
  const markers = state.phase === "markers" ? roll >= 2 : roll < 2;
  const count = edgeNotchCount(state.options.boardSize);
  if (markers) {
    const edgeNotch =
      roll % 3 === 0 ? pick([-1, count, count + rng.nextInt(1000)], rng) : rng.nextInt(count);
    return { type: "place-marker", edgeNotch };
  }
  const hand = at(state.hands, seat);
  const tileId = hand.length > 0 && roll % 2 === 0 ? pick(hand, rng) : rng.nextInt(TILE_COUNT);
  return { type: "place-tile", tileId, rotation: rng.nextInt(ROTATIONS) };
}

/**
 * Deals every tile `viewer` can't see at random into the same places: the deck (whose order is
 * always hidden) and, while the game is in progress, the other players' hands (everyone's for the
 * public viewer). Every count stays the same, and so does everything the viewer can see.
 */
function perturbHidden(state: State, viewer: Seat | null, rng: RandomSource): State {
  const next = copyState(state);
  const inProgress = state.endReason === null;
  const others = state.hands.flatMap((_, seat) => (inProgress && seat !== viewer ? [seat] : []));
  const tiles = shuffle([...state.deck, ...others.flatMap((seat) => at(state.hands, seat))], rng);
  next.deck = tiles.splice(0, state.deck.length);
  for (const seat of others) {
    next.hands[seat] = tiles.splice(0, at(state.hands, seat).length).sort(ascending);
  }
  return next;
}

/**
 * An upper bound on the transitions in a game (paths §7): one marker per player, at most one tile
 * per tile in the set, and at most one resignation or timeout per player. Skips are not actions.
 */
function maxActions(_options: Options, seats: number): number {
  return seats + TILE_COUNT + seats;
}

/**
 * The option inputs the kit plays (02 §6): the defaults, each hand size, the `allowed` variant,
 * and the smallest hand with it (which runs players out of tiles soonest, so skips, the token
 * and the board-full ending come up most often).
 */
function optionInputs(): readonly unknown[] {
  return [
    {},
    { handSize: HAND_SIZE.min },
    { handSize: 2 },
    { selfElimination: "allowed" },
    { boardSize: 6, handSize: HAND_SIZE.min, selfElimination: "allowed" },
  ];
}

/** How many random games `worstCase` searches, and how many states it keeps. */
const SEARCH_GAMES = 6;
const KEEP = 4;

/** A candidate input and the tile paths `validate` + `apply` trace for it. */
interface Candidate {
  readonly cost: number;
  readonly eliminates: boolean;
  readonly input: WorstCase<State, Action>;
}

/**
 * The costliest placement at `state` for the seat to act, and the costliest one that puts the
 * mover out, if any is legal. A placement's cost is what `validate` and `apply` actually trace:
 * the placement itself once in each, plus, under `avoidIfPossible` when it puts the mover out,
 * every tile and rotation in hand (`validate` looks for one that wouldn't, paths §3 step 4).
 */
function candidates(state: State, seat: Seat): { best: Candidate; eliminating?: Candidate } {
  const traced = (placed: Placed): { length: number; eliminates: boolean } => {
    const moved = movement(state.board, state.markers, faced(state, seat), placed);
    return {
      length: moved.moves.reduce((sum, move) => sum + move.path.length, 0),
      eliminates: moved.eliminated.includes(seat),
    };
  };
  const hand = at(state.hands, seat).flatMap((tileId) =>
    Array.from({ length: ROTATIONS }, (_, rotation) => traced({ tileId, rotation })),
  );
  const everyOption = hand.reduce((sum, option) => sum + option.length, 0);
  const avoid = state.options.selfElimination === "avoidIfPossible";
  const costed = legalPlacements(state, seat).map((placed): Candidate => {
    const { length, eliminates } = traced(placed);
    return {
      cost: 2 * length + (avoid && eliminates ? everyOption : 0),
      eliminates,
      input: { state, seat, action: tileAction(placed) },
    };
  });
  const byCost = costed.sort((a, b) => b.cost - a.cost);
  const best = at(byCost, 0);
  const eliminating = byCost.find((candidate) => candidate.eliminates);
  return eliminating === undefined ? { best } : { best, eliminating };
}

/**
 * The most expensive inputs for the CPU budget (02 §6.6, paths §7). A heuristic search, not a
 * proof: seeded random games are played to their end, every tile turn is costed by
 * {@link candidates}, and the `KEEP` costliest states are kept (one input each), plus the costliest
 * placement that puts the mover out if none of those does.
 */
function worstCase(
  options: Options,
  seats: number,
  rng: RandomSource,
): readonly WorstCase<State, Action>[] {
  const best: Candidate[] = [];
  const eliminating: Candidate[] = [];
  for (let game = 0; game < SEARCH_GAMES; game += 1) {
    let state = setup({ options, seats, rng });
    while (state.turn !== null) {
      const seat = state.turn;
      if (state.phase === "markers") {
        state = placeMarker(state, seat, pick(freeEdgeNotches(state), rng)).state;
        continue;
      }
      const found = candidates(state, seat);
      best.push(found.best);
      if (found.eliminating !== undefined) eliminating.push(found.eliminating);
      state = placeTile(state, seat, pick(legalPlacements(state, seat), rng), rng).state;
    }
  }
  const byCost = (a: Candidate, b: Candidate): number => b.cost - a.cost;
  const kept = best.sort(byCost).slice(0, KEEP);
  const [worstExit] = eliminating.sort(byCost);
  if (worstExit !== undefined && !kept.some((candidate) => candidate.eliminates)) {
    kept.push(worstExit);
  }
  return kept.map((candidate) => candidate.input);
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
