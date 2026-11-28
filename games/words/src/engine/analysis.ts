/**
 * Play analysis from a view alone (docs/spec/games/words.md §10.4, §10.5, 07 §3). The engine's own
 * `analysePlay` takes the board and the submitter's rack; a client has exactly those in the
 * viewer's `View` (the public board and `yourRack`), so it can check placements and score a play
 * locally, as the server does. The result is non-authoritative and never looks a word up: the
 * dictionary check is the server's, or the client's own list for a public dictionary.
 */
import { isGameError, type GameError } from "@your-move/sdk";

import { analysePlay, type PlayAnalysis } from "./board.js";
import { findRuleset } from "./rulesets/index.js";
import { ERROR_CODES, type Placement, type PreviewResult, type View } from "./schemas.js";

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

/**
 * The words a play forms that `has` doesn't know, each once, in the order formed. Shared by the
 * engine's `check` and the client's local preview, so both give the same answer (words §10.5).
 */
export function unknownWords(analysis: PlayAnalysis, has: (word: string) => boolean): string[] {
  const words = [...new Set(analysis.words.map((scored) => scored.word))];
  return words.filter((word) => !has(word));
}

/**
 * What the engine's `preview` of a play gives on the full state, from a `View` and the game's
 * `public` word list (words §10.5, 07 §4): the same score, words and bingo, the same errors in
 * the same check order (every placement rule, then the words). `has` may throw; the caller then
 * asks the server instead.
 */
export function previewViewPlay(
  view: View,
  placements: readonly Placement[],
  has: (word: string) => boolean,
): PreviewResult | GameError {
  const analysis = analyseViewPlay(view, placements);
  if (isGameError(analysis)) return analysis;
  const words = unknownWords(analysis, has);
  if (words.length > 0) return { code: ERROR_CODES.invalidWords, detail: { words } };
  return { score: analysis.score, words: [...analysis.words], bingo: analysis.bingo };
}
