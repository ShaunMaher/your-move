/**
 * The paths client module: board, options form, rules sheet and history items
 * (docs/spec/02-game-framework.md §3, docs/spec/games/paths.md §8). The web app lazy-loads it the
 * first time a game of this type is opened.
 */
import type { GameClientModule } from "@your-move/sdk/client";

import { engines, type Action, type Options, type View } from "../engine/index.js";
import { Board } from "./Board.js";
import { HistoryItem } from "./HistoryItem.js";
import { OptionsForm } from "./OptionsForm.js";
import { RulesSheet } from "./RulesSheet.js";

export const client: GameClientModule<Options, Action, View> = {
  type: "paths",
  versions: Object.keys(engines).map(Number),
  OptionsForm,
  Board,
  RulesSheet,
  HistoryItem,
};
