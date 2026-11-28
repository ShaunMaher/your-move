/**
 * The generic test kit (docs/spec/02-game-framework.md §6) and the built-output rules for game
 * packages (§7.5).
 *
 * - `runKit(engines, { mode, manifest })` plays seeded random games through every rules version
 *   and checks schema conformance, replay, perturbation secrecy, termination, turn sanity, the
 *   CPU budget and isolation between games, plus the manifest (02 §7.2) and its icon.
 * - The dependency-cruiser import ruleset (`@your-move/testkit/depcruise`) and the engine ESLint
 *   config (`@your-move/testkit/eslint-engine`), run on built output.
 *
 * @packageDocumentation
 */
export { gamePackageRules, type GamePackageLayout } from "./depcruise.js";
export { ENGINE_GLOBALS, engineEslintConfig } from "./eslint-engine.js";
export { checkIcon } from "./icon.js";
export {
  runKit,
  type KitFailure,
  type KitMode,
  type KitOptions,
  type KitProperty,
  type KitReport,
  type KitShard,
} from "./kit.js";
export {
  CPU_BUDGET_VARIABLE,
  DEFAULT_CPU_BUDGET_MS,
  MAX_CPU_BUDGET_MS,
  readCpuBudget,
  type CpuBudget,
} from "./budget.js";
export { checkManifest } from "./manifest.js";
export { seededRandom } from "./random.js";
