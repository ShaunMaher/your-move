/**
 * The words client module: board, options form, rules sheet and history items
 * (docs/spec/02-game-framework.md §3, docs/spec/games/words.md). The web app lazy-loads it the
 * first time a game of this type is opened.
 */
import type { GameClientModule } from "@your-move/sdk/client";

import {
  engines,
  type Action,
  type Options,
  type PreviewResult,
  type View,
} from "../engine/index.js";
import { Board } from "./Board.js";
import { HistoryItem } from "./HistoryItem.js";
import { OptionsForm } from "./OptionsForm.js";
import { RulesSheet } from "./RulesSheet.js";

export const client: GameClientModule<Options, Action, View, PreviewResult> = {
  type: "words",
  versions: Object.keys(engines).map(Number),
  OptionsForm,
  Board,
  RulesSheet,
  HistoryItem,
};
