/**
 * The generic test kit (docs/spec/02-game-framework.md §6) and the built-output rules for game
 * packages (§7.5).
 *
 * M0 ships the rules: the dependency-cruiser import ruleset (`@your-move/testkit/depcruise`) and
 * the engine ESLint config (`@your-move/testkit/eslint-engine`). The kit itself (schema, replay,
 * perturbation secrecy, termination, turn sanity, CPU budget, isolation) arrives in M1.
 *
 * @packageDocumentation
 */
export { gamePackageRules, type GamePackageLayout } from "./depcruise.js";
export { ENGINE_GLOBALS, engineEslintConfig } from "./eslint-engine.js";
