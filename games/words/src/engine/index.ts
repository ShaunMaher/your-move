/**
 * The words engine: one `GameDefinition` per supported rules version
 * (docs/spec/02-game-framework.md §7.1, docs/spec/games/words.md).
 *
 * M1b part 1 ships the ruleset data, the registry, the compatibility check and the swap variants.
 * The game itself (`GameDefinition`) arrives in part 2; until then no rules version is exported,
 * so the package isn't installed into an instance (instance.config.ts).
 */
export const engines: Readonly<Record<number, never>> = {};

export { isCompatible, missingLetters, type DictionaryTraits } from "./compatibility.js";
export {
  createRegistry,
  findRuleset,
  latestRuleset,
  RULESETS,
  type RulesetRegistry,
} from "./rulesets/index.js";
export {
  BLANK,
  isQuarterTurnSymmetric,
  MAX_BOARD_SIZE,
  premiumCounts,
  rulesetSchema,
  SWAP_ORDERS,
  totalTiles,
  type Premium,
  type Ruleset,
  type RulesetData,
  type SwapOrder,
} from "./rulesets/schema.js";
export { draw, removeFromRack, swapTiles, type RackAndBag } from "./swap.js";
