/**
 * The words engine: one `GameDefinition` per supported rules version
 * (docs/spec/02-game-framework.md §7.1, docs/spec/games/words.md).
 *
 * M1b part 1 ships the ruleset data, the registry, the compatibility check and the swap variants.
 * The game itself (`GameDefinition`) arrives in part 2; until then no rules version is exported,
 * so the package isn't installed into an instance (instance.config.ts). The client reaches the
 * rulesets through the exports below.
 */
export const engines: Readonly<Record<number, never>> = {};

export { isCompatible, type DictionaryTraits } from "./compatibility.js";
export { findRuleset, latestRuleset, RULESETS, type RulesetRegistry } from "./rulesets/index.js";
export {
  premiumCounts,
  type Premium,
  type Ruleset,
  type RulesetData,
  type SwapOrder,
} from "./rulesets/schema.js";
