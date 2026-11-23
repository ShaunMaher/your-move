---
"@your-move/testkit": minor
---

First release of the generic test kit (02 §6): `runKit(engines, { mode, manifest })` checks
schema conformance, replay, perturbation secrecy, termination, turn sanity, the CPU budget and
isolation between games, in fast and full modes, plus `checkManifest`, `checkIcon` and
`seededRandom`. The built-output rules ship as `@your-move/testkit/depcruise` and
`@your-move/testkit/eslint-engine`; the engine lint now allows `instanceof`, `Error` subclasses and
`Number`/`String`/`Boolean` as array callbacks.
