/**
 * Validation and preview (docs/spec/games/words.md §3, §10.3, §10.5).
 *
 * Check order (first failure wins): every `INVALID_PLACEMENT` check, rack checks included, runs
 * before any dictionary lookup, and `INVALID_WORDS` comes last. Every answer is computed from the
 * submitter's own rack and the public board and bag count only (02 §2.1 rule 4, words §7).
 */
import {
  isGameError,
  OK,
  type GameError,
  type Ok,
  type Resources,
  type Seat,
} from "@your-move/sdk";

import { unknownWords } from "./analysis.js";
import { analysePlay, type PlayAnalysis } from "./board.js";
import { ERROR_CODES, type Action, type PreviewResult } from "./schemas.js";
import { rackOf, rulesetOf, type State } from "./state.js";

/** Whether every tile is in the rack, counting repeats. */
function inRack(rack: readonly string[], tiles: readonly string[]): boolean {
  const left = [...rack];
  return tiles.every((tile) => {
    const index = left.indexOf(tile);
    if (index !== -1) left.splice(index, 1);
    return index !== -1;
  });
}

/**
 * Checks `action` for `seat` (words §10.3); for a legal play, also what it scores. A seat that
 * isn't to act gets `NOT_TO_ACT` (the framework never asks for one).
 */
export function check(
  state: State,
  seat: Seat,
  action: Action,
  res: Resources,
): PlayAnalysis | Ok | GameError {
  if (state.finished !== null || seat !== state.turn) return { code: ERROR_CODES.notToAct };
  const ruleset = rulesetOf(state.options);
  const rack = rackOf(state, seat);
  switch (action.type) {
    case "play": {
      const analysis = analysePlay(ruleset, state.board, rack, action.placements);
      if (isGameError(analysis)) return analysis;
      // Without a dictionary nothing can be checked, so no word is accepted.
      const words = unknownWords(analysis, (word) => res.dictionary?.has(word) === true);
      return words.length === 0 ? analysis : { code: ERROR_CODES.invalidWords, detail: { words } };
    }
    case "swap":
      if (state.bag.length < ruleset.swapMinBag) {
        return { code: ERROR_CODES.swapNotAllowed, detail: "BAG_TOO_SMALL" };
      }
      if (!inRack(rack, action.tiles)) {
        return { code: ERROR_CODES.swapNotAllowed, detail: "TILE_NOT_IN_RACK" };
      }
      return OK;
    case "pass":
      return OK;
  }
}

/** Whether `seat` may take `action` now (02 §2 `validate`). */
export function validate(state: State, seat: Seat, action: Action, res: Resources): Ok | GameError {
  const verdict = check(state, seat, action, res);
  return isGameError(verdict) ? verdict : OK;
}

/** What `action` would score (words §10.5), or the error `validate` gives. */
export function preview(
  state: State,
  seat: Seat,
  action: Action,
  res: Resources,
): PreviewResult | GameError {
  const verdict = check(state, seat, action, res);
  if (isGameError(verdict)) return verdict;
  if ("words" in verdict) {
    return { score: verdict.score, words: [...verdict.words], bingo: verdict.bingo };
  }
  return { score: 0, words: [], bingo: false };
}
