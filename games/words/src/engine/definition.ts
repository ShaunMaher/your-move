/**
 * Rules version 1 of the words game as a `GameDefinition` (docs/spec/games/words.md §10,
 * docs/spec/02-game-framework.md §2). The rules live in `board.ts`, `rules.ts` and `state.ts`;
 * this module wires them to the contract.
 */
import type { GameDefinition } from "@your-move/sdk";

import { testHooks } from "./kit-hooks.js";
import { catalog, checkConfig, players, resolveOptions, validateStart } from "./options.js";
import { describe, summary, view } from "./present.js";
import { preview, validate } from "./rules.js";
import {
  actionSchema,
  catalogSchema,
  configSchema,
  DEFAULT_TURN_TIMEOUT_DAYS,
  ERROR_CODES,
  GAME_TYPE,
  optionsSchema,
  previewSchema,
  recordSchema,
  viewSchema,
  type Action,
  type Options,
  type PreviewResult,
  type PublicRecord,
  type View,
} from "./schemas.js";
import {
  leave,
  pass,
  playTiles,
  result,
  seatStatus,
  setup,
  swap,
  toAct,
  type State,
} from "./state.js";

/** The words game's definition type, with its own option, state, action and view types. */
type WordsGame = GameDefinition<Options, State, Action, View, PublicRecord, PreviewResult>;

/** Rules version 1. */
export const wordsV1: WordsGame = {
  type: GAME_TYPE,
  version: 1,

  configSchema,
  optionsSchema,
  actionSchema,
  viewSchema,
  recordSchema,
  previewSchema,
  catalogSchema,
  errorCodes: Object.values(ERROR_CODES),

  resolveOptions,
  catalog,
  players,
  validateStart,
  defaultTurnTimeoutDays: () => DEFAULT_TURN_TIMEOUT_DAYS,
  resources: (options) => [
    { kind: "dictionary", id: options.dictionaryId, version: options.dictionaryVersion },
  ],
  checkConfig,

  setup,
  toAct,
  seatStatus,
  validate,
  apply: (state, seat, action, rng) => {
    switch (action.type) {
      case "play":
        return playTiles(state, seat, action);
      case "swap":
        return swap(state, seat, action, rng);
      case "pass":
        return pass(state, seat);
    }
  },
  onResign: (state, seat, _rng, reason) => leave(state, seat, reason),
  onTimeout: (state, seat) => leave(state, seat, "timeout"),
  result,

  view,
  preview,
  describe,
  summary: (state) => summary(state),

  test: testHooks,
};
