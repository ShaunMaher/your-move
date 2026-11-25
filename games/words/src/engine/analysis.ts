/**
 * Play analysis from a view alone (docs/spec/games/words.md §10.4, §10.5, 07 §3). The engine's own
 * `analysePlay` takes the board and the submitter's rack; a client has exactly those in the
 * viewer's `View` (the public board and `yourRack`), so it can check placements and score a play
 * locally, as the server does. The result is non-authoritative and never looks a word up: the
 * dictionary check is the server's, or the client's own list for a public dictionary.
 */
import type { GameError } from "@your-move/sdk";

import { analysePlay, type PlayAnalysis } from "./board.js";
import { findRuleset } from "./rulesets/index.js";
import { ERROR_CODES, type Placement, type View } from "./schemas.js";

/**
 * Checks every placement rule of words §10.3 (the dictionary aside) against the viewer's view and
 * scores the play. A public view (no rack), an unknown ruleset version and an empty play are
 * errors rather than throws: a client shows them to the player.
 */
export function analyseViewPlay(
  view: View,
  placements: readonly Placement[],
): PlayAnalysis | GameError {
  const ruleset = findRuleset(view.ruleset.id, view.ruleset.version);
  if (ruleset === undefined) return { code: ERROR_CODES.unknownRuleset };
  if (view.yourRack === null) return { code: ERROR_CODES.notToAct };
  if (placements.length === 0) {
    return { code: ERROR_CODES.invalidPlacement, detail: "TOO_FEW_TILES" };
  }
  return analysePlay(ruleset, view.board, view.yourRack, placements);
}
