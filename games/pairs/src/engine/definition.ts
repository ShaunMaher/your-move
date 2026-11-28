/**
 * Rules version 1 of the pairs game as a `GameDefinition` (docs/spec/games/pairs.md §8,
 * docs/spec/02-game-framework.md §2). The rules live in `rules.ts` and `state.ts`; this module
 * wires them to the contract.
 */
import { OK, type GameDefinition } from "@your-move/sdk";

import { testHooks } from "./kit-hooks.js";
import { catalog, resolveOptions } from "./options.js";
import { describe, summary, view } from "./present.js";
import { cardIndex, validate } from "./rules.js";
import {
  actionSchema,
  catalogSchema,
  configSchema,
  DEFAULT_TURN_TIMEOUT_DAYS,
  ERROR_CODES,
  GAME_TYPE,
  optionsSchema,
  PLAYERS,
  recordSchema,
  viewSchema,
  type Action,
  type Options,
  type PublicRecord,
  type View,
} from "./schemas.js";
import { flip, leave, result, seatStatus, setup, toAct, type State } from "./state.js";

/** The pairs game's definition type: no preview (pairs §8.3). */
type PairsGame = GameDefinition<Options, State, Action, View, PublicRecord>;

/** Rules version 1. */
export const pairsV1: PairsGame = {
  type: GAME_TYPE,
  version: 1,

  configSchema,
  optionsSchema,
  actionSchema,
  viewSchema,
  recordSchema,
  catalogSchema,
  errorCodes: Object.values(ERROR_CODES),

  resolveOptions,
  catalog,
  players: () => ({ ...PLAYERS }),
  validateStart: () => OK,
  defaultTurnTimeoutDays: () => DEFAULT_TURN_TIMEOUT_DAYS,
  resources: () => [],
  checkConfig: () => OK,

  setup,
  toAct,
  seatStatus,
  validate: (state, seat, action) => validate(state, seat, action),
  apply: (state, seat, action) => flip(state, seat, cardIndex(state, action.row, action.column)),
  onResign: (state, seat, _rng, reason) => leave(state, seat, reason),
  onTimeout: (state, seat) => leave(state, seat, "timeout"),
  result,

  view,
  describe,
  summary,

  test: testHooks,
};
