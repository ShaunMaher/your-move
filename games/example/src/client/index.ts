/**
 * The example client module: board, options form, rules sheet and history items
 * (docs/spec/02-game-framework.md §3, §7.6). The web app lazy-loads it the first time a game of
 * this type is opened.
 */
import type { GameClientModule } from "@your-move/sdk/client";

import type { Action, Options, PreviewResult, View } from "../engine/index.js";
import { Board } from "./Board.js";
import { HistoryItem } from "./HistoryItem.js";
import { OptionsForm } from "./OptionsForm.js";
import { RulesSheet } from "./RulesSheet.js";

export const client: GameClientModule<Options, Action, View, PreviewResult> = {
  type: "example",
  versions: [1],
  OptionsForm,
  Board,
  RulesSheet,
  HistoryItem,
};
