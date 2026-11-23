/**
 * Rules version 1 of the example game as a `GameDefinition` (docs/spec/02-game-framework.md §2,
 * §7.6). The rules themselves live in `state.ts`; this module wires them to the contract.
 */
import {
  isGameError,
  OK,
  type GameDefinition,
  type GameError,
  type Ok,
  type Seat,
  type Transition,
} from "@your-move/sdk";

import { at } from "./at.js";
import { testHooks } from "./kit-hooks.js";
import { catalog, resolveOptions, validateStart } from "./options.js";
import { describe, summary, view } from "./present.js";
import {
  actionSchema,
  catalogSchema,
  configSchema,
  ERROR_CODES,
  GAME_TYPE,
  optionsSchema,
  PLAYERS,
  previewSchema,
  recordSchema,
  viewSchema,
  type Action,
  type Options,
  type PreviewResult,
  type PublicRecord,
  type View,
} from "./schemas.js";
import { playCard, removeSeat, result, setup, toAct, type State } from "./state.js";

/**
 * Whether `seat` may play `action` now (02 §2 `validate`). The answer depends only on public state
 * and the seat's own hand, never on anyone else's cards (02 §2.1 rule 4). The framework already
 * lets only seats in `toAct` act; the first three checks keep `validate` total anyway.
 */
function validate(state: State, seat: Seat, action: Action): Ok | GameError {
  if (state.endReason !== null) return { code: ERROR_CODES.gameOver };
  if (state.status[seat] !== "playing") return { code: ERROR_CODES.notPlaying };
  if (state.pending[seat] !== null) return { code: ERROR_CODES.alreadyPlayed };
  if (!at(state.hands, seat).includes(action.card)) return { code: ERROR_CODES.notInHand };
  return OK;
}

/** What would be left in the seat's hand (02 §2 `preview`), or the error `validate` gives. */
function preview(state: State, seat: Seat, action: Action): PreviewResult | GameError {
  const valid = validate(state, seat, action);
  if (isGameError(valid)) return valid;
  return { handAfter: at(state.hands, seat).filter((card) => card !== action.card) };
}

/** A seat leaves (02 §4): the record names only the seat and why, so it hides nothing. */
function exit(state: State, seat: Seat, record: PublicRecord): Transition<State, PublicRecord> {
  return { state: removeSeat(state, seat), record };
}

/** The example game's definition type, with its own option, state, action and view types. */
type ExampleGame = GameDefinition<Options, State, Action, View, PublicRecord, PreviewResult>;

/** Rules version 1. */
export const exampleV1: ExampleGame = {
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
  players: () => ({ ...PLAYERS }),
  validateStart,
  defaultTurnTimeoutDays: () => 3,
  resources: () => [],
  checkConfig: () => OK,

  setup,
  toAct,
  seatStatus: (state) => [...state.status],
  validate,
  // Randomness is used only to shuffle at setup: no transition draws, so no record can show a
  // draw (02 §2.1 rule 2, §6.3).
  apply: (state, seat, action) => ({
    state: playCard(state, seat, action.card),
    record: { kind: "played", seat, round: state.round },
  }),
  onResign: (state, seat, _rng, reason) =>
    exit(state, seat, { kind: reason === "decline" ? "declined" : "resigned", seat }),
  onTimeout: (state, seat) => exit(state, seat, { kind: "timedOut", seat }),
  result,

  view,
  preview,
  describe,
  summary,

  test: testHooks,
};
