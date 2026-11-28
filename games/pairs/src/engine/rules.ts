/**
 * Which flips are legal (docs/spec/games/pairs.md §3, §8.3). Every check reads only `turn`,
 * `endReason`, the grid size, `matchedBy` and `turned`, never a face (02 §2.1 rule 4).
 */
import { OK, type GameError, type Ok, type Seat } from "@your-move/sdk";

import { ERROR_CODES, type Action } from "./schemas.js";
import { gridFor, type State } from "./state.js";

/** The card index of `(row, column)`, in reading order (pairs §1). */
export function cardIndex(state: State, row: number, column: number): number {
  return row * gridFor(state).columns + column;
}

/** Whether card `card` may be turned: it is neither matched nor the turn's first card. */
export function turnable(state: State, card: number): boolean {
  return state.matchedBy[card] === null && state.turned !== card;
}

/** Checks a flip; the first failure wins, and none carries a detail (pairs §8.3). */
export function validate(state: State, seat: Seat, action: Action): Ok | GameError {
  if (state.endReason !== null || state.turn !== seat) return { code: ERROR_CODES.notToAct };
  const { rows, columns } = gridFor(state);
  const { row, column } = action;
  if (row < 0 || row >= rows || column < 0 || column >= columns) {
    return { code: ERROR_CODES.outOfRange };
  }
  if (!turnable(state, cardIndex(state, row, column))) return { code: ERROR_CODES.cardFaceUp };
  return OK;
}
