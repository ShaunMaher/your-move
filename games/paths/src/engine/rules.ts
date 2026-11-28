/**
 * Validation (docs/spec/games/paths.md §3 step 4, §7 "Errors"). Checked in this order, first
 * failure wins: `NOT_TO_ACT` → `WRONG_PHASE` → `OUT_OF_RANGE` → `NOTCH_OCCUPIED` / `NOT_IN_HAND`
 * → `SELF_ELIMINATION_AVOIDABLE`. Every answer depends only on the board, the markers and the
 * submitter's own hand (02 §2.1 rule 4).
 */
import { OK, type GameError, type Ok, type Seat } from "@your-move/sdk";

import { at } from "./at.js";
import { edgeNotch, edgeNotchCount, samePosition } from "./geometry.js";
import { livePosition, movement, type Board, type Square } from "./movement.js";
import { ERROR_CODES, type Action, type Marker, type Placed } from "./schemas.js";
import { faced, type State } from "./state.js";
import { ROTATIONS } from "./tiles.js";

/** What the self-elimination rule (paths §3 step 4) says about one placement. */
export interface SelfElimination {
  /** Whether placing it would put the mover's own marker off the board. */
  readonly eliminates: boolean;
  /**
   * Whether some tile and rotation in the mover's hand would keep their marker on the board; null
   * when that wasn't searched for, which is unless the variant is on and this placement
   * eliminates (so the `allowed` variant, and a safe placement, trace nothing extra: the kit's
   * cost model, `candidates` in kit-hooks.ts, counts the search only in that case).
   */
  readonly safeExists: boolean | null;
  /** Whether the rule refuses it: it eliminates, another choice doesn't, and the variant is on. */
  readonly blocked: boolean;
}

/** Whether placing `placed` on `target` would put `seat`'s own marker out. */
function eliminatesSelf(
  board: Board,
  markers: readonly Marker[],
  seat: Seat,
  target: Square,
  placed: Placed,
): boolean {
  return movement(board, markers, target, placed).eliminated.includes(seat);
}

/**
 * The self-elimination rule as one pure function of the public board, the markers, the mover's
 * marker's target square and the mover's own hand, so the server's `validate` and the client's
 * preview share it (paths §3 step 4, §8).
 */
export function selfElimination(
  board: Board,
  markers: readonly Marker[],
  seat: Seat,
  target: Square,
  hand: readonly number[],
  avoidIfPossible: boolean,
  placed: Placed,
): SelfElimination {
  const eliminates = eliminatesSelf(board, markers, seat, target, placed);
  const safeExists =
    avoidIfPossible && eliminates
      ? hand.some((tileId) =>
          Array.from({ length: ROTATIONS }, (_, rotation) => rotation).some(
            (rotation) => !eliminatesSelf(board, markers, seat, target, { tileId, rotation }),
          ),
        )
      : null;
  return { eliminates, safeExists, blocked: safeExists === true };
}

/** Every tile and rotation in `seat`'s hand, with whether it puts the mover out. */
function options(state: State, seat: Seat): { placed: Placed; eliminates: boolean }[] {
  const target = faced(state, seat);
  return at(state.hands, seat).flatMap((tileId) =>
    Array.from({ length: ROTATIONS }, (_, rotation) => {
      const placed = { tileId, rotation };
      return {
        placed,
        eliminates: eliminatesSelf(state.board, state.markers, seat, target, placed),
      };
    }),
  );
}

/**
 * The placements `seat` may make (paths §3 step 4): with `avoidIfPossible`, those that keep its
 * marker on the board if there are any; otherwise every tile and rotation in hand.
 */
export function legalPlacements(state: State, seat: Seat): Placed[] {
  const all = options(state, seat);
  const safe = all.filter((option) => !option.eliminates);
  const chosen = state.options.selfElimination === "allowed" || safe.length === 0 ? all : safe;
  return chosen.map(({ placed }) => placed);
}

/** The edge notches no marker is on (paths §2 step 3). */
export function freeEdgeNotches(state: State): number[] {
  const size = state.options.boardSize;
  const taken = state.markers.flatMap((marker) => {
    const pos = livePosition(marker);
    return pos === null ? [] : [pos];
  });
  return Array.from({ length: edgeNotchCount(size) }, (_, e) => e).filter((e) => {
    const pos = edgeNotch(size, e);
    return !taken.some((other) => samePosition(pos, other));
  });
}

/** Whether `seat` may take `action` now (02 §2 `validate`). */
export function validate(state: State, seat: Seat, action: Action): Ok | GameError {
  if (state.turn !== seat) return { code: ERROR_CODES.notToAct };
  if (action.type === "place-marker") {
    if (state.phase !== "markers") return { code: ERROR_CODES.wrongPhase };
    const size = state.options.boardSize;
    if (action.edgeNotch < 0 || action.edgeNotch >= edgeNotchCount(size)) {
      return { code: ERROR_CODES.outOfRange };
    }
    return freeEdgeNotches(state).includes(action.edgeNotch)
      ? OK
      : { code: ERROR_CODES.notchOccupied };
  }
  if (state.phase !== "tiles") return { code: ERROR_CODES.wrongPhase };
  if (!at(state.hands, seat).includes(action.tileId)) return { code: ERROR_CODES.notInHand };
  const placed = { tileId: action.tileId, rotation: action.rotation };
  const verdict = selfElimination(
    state.board,
    state.markers,
    seat,
    faced(state, seat),
    at(state.hands, seat),
    state.options.selfElimination === "avoidIfPossible",
    placed,
  );
  if (verdict.blocked) return { code: ERROR_CODES.selfEliminationAvoidable };
  return OK;
}
