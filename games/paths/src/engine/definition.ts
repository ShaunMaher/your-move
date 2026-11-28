/**
 * Rules version 1 of the paths game as a `GameDefinition` (docs/spec/games/paths.md §7,
 * docs/spec/02-game-framework.md §2). The rules live in `movement.ts`, `rules.ts` and `state.ts`;
 * this module wires them to the contract.
 */
import { OK, type GameDefinition } from "@your-move/sdk";

import { testHooks } from "./kit-hooks.js";
import { catalog, resolveOptions } from "./options.js";
import { describe, summary, view } from "./present.js";
import { validate } from "./rules.js";
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
import {
  leave,
  placeMarker,
  placeTile,
  result,
  seatStatus,
  setup,
  toAct,
  type State,
} from "./state.js";

/** The paths game's definition type: no preview on the server (paths §7). */
type PathsGame = GameDefinition<Options, State, Action, View, PublicRecord>;

/** Rules version 1. */
export const pathsV1: PathsGame = {
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
  validate,
  apply: (state, seat, action, rng) =>
    action.type === "place-marker"
      ? placeMarker(state, seat, action.edgeNotch)
      : placeTile(state, seat, { tileId: action.tileId, rotation: action.rotation }, rng),
  onResign: (state, seat, rng, reason) => leave(state, seat, rng, reason),
  onTimeout: (state, seat, rng) => leave(state, seat, rng, "timeout"),
  result,

  view,
  describe,
  summary,

  test: testHooks,
};
