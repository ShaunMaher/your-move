/**
 * The words engine: one `GameDefinition` per supported rules version
 * (docs/spec/02-game-framework.md §7.1, §7.4, docs/spec/games/words.md §10). A new rules version
 * is added here alongside the old ones, which stay exported while any live game may use them.
 * The client also reaches the rulesets, compatibility and the schemas through this entry point.
 */
import type { GameEngines } from "@your-move/sdk";

import { wordsV1 } from "./definition.js";

export const engines = { 1: wordsV1 } satisfies GameEngines;

export { isCompatible, type DictionaryTraits } from "./compatibility.js";
export { findRuleset, latestRuleset, RULESETS, type RulesetRegistry } from "./rulesets/index.js";
export {
  premiumCounts,
  type Premium,
  type Ruleset,
  type RulesetData,
  type SwapOrder,
} from "./rulesets/schema.js";
export {
  actionSchema,
  catalogSchema,
  previewSchema,
  recordSchema,
  viewSchema,
  type Action,
  type Catalog,
  type Options,
  type PreviewResult,
  type PublicRecord,
  type View,
} from "./schemas.js";
