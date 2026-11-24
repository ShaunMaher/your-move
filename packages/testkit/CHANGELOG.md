# @your-move/testkit

## 0.1.0

### Minor Changes

- 2c4fe52: First release of the generic test kit (02 §6): `runKit(engines, { mode, manifest })` checks
  schema conformance, replay, perturbation secrecy, termination, turn sanity, the CPU budget and
  isolation between games, in fast and full modes, plus `checkManifest`, `checkIcon` and
  `seededRandom`. The kit plays the option inputs, context and resources the module's own test
  hooks give; `cpuBudgetMs` sets the CPU budget and `stopAtFirstFailure` stops at the first
  failing game. The built-output rules ship as `@your-move/testkit/depcruise` and
  `@your-move/testkit/eslint-engine`; the engine lint now allows `instanceof`, `Error` subclasses and
  `Number`/`String`/`Boolean` as array callbacks.

### Patch Changes

- Updated dependencies [2c4fe52]
  - @your-move/sdk@0.1.0
