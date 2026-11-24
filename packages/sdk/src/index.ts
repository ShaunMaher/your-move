/**
 * The game SDK: the versioned contract between the framework and every game package
 * (docs/spec/02-game-framework.md §2, §3, §7). This entry point holds types and pure helpers and
 * never imports React; `@your-move/sdk/schema` re-exports Zod and `@your-move/sdk/client` holds the
 * client module type and React helpers.
 *
 * The SDK is 0.x until the MVP (02 §7.4): any minor may break, with a migration note.
 *
 * @packageDocumentation
 */
export {
  OK,
  RESERVED_ERROR_CODES,
  isGameError,
  type AnyGameDefinition,
  type ExitReason,
  type GameDefinition,
  type GameEngines,
  type GameError,
  type GameResult,
  type GameTestHooks,
  type ListSummary,
  type ModuleConfig,
  type Ok,
  type OptionsContext,
  type RankingEntry,
  type ResourceCatalog,
  type ResourceKind,
  type ResourceMeta,
  type ResourceRequest,
  type Resources,
  type Schema,
  type Seat,
  type Text,
  type Transition,
  type WorstCase,
} from "./contract.js";
export {
  ReplayMismatchError,
  assertRange,
  recordRandom,
  replayRandom,
  shuffle,
  type RandomSource,
  type RecordingRandom,
  type ReplaySource,
} from "./random.js";
export {
  frameworkErrorSchema,
  gameEnvelopeSchema,
  gameErrorSchema,
  gamePlayerSchema,
  gameResourceSchema,
  gameStatusSchema,
  listSummarySchema,
  submitResultSchema,
  textSchema,
  type FrameworkError,
  type GameEnvelope,
  type SubmitResult,
} from "./api.js";
export { GAME_TYPE_PATTERN, isGameType, type GameManifest } from "./manifest.js";
