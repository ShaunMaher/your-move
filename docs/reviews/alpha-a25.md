# Alpha A25 review (the `pairs` engine and the kit's `hiddenFromEveryone` check): resolutions

This record covers the review of `alpha-a25-pairs-engine`: the pure `pairs` engine (rules version 1, not yet installed) and the test kit's check of `hiddenFromEveryone` (spec v0.9.49). It had two rounds of the picky review (A25-P, A25-P2) and of the security review (A25-S, A25-S2). The owner read the kit check and the narrowed 02 §6.3 and signed off.

Owner decisions:
- under the flag, the kit also compares every non-acting seat's summary with the public's (A25-S-1);
- what the seats to act learn is stated as resting on `perturbHidden`, and a module's own coverage test is required, with the stronger check in the backlog (A25-S2-1);
- the full kit's CI cost goes to a chores slice before the pairs client, with the spec's game counts kept (A25-P-1).

| ID | Outcome | Where |
|---|---|---|
| A25-S-1 | Fixed (owner decision). Summaries of seats not to act must equal the public's; a fixture of the reviewer's probe. | `packages/testkit/src/kit.ts`, 02 §6.3 |
| A25-S-2 | Fixed. Fixtures for the M1a P2-1 shape and for views that differ only late in the game. | `packages/testkit/src/test-support.ts`, `kit.test.ts` |
| A25-S-3, A25-S-4, A25-P2-1 | Fixed. The flag read once per rules version; the engine's tables frozen. | `kit.ts`, `games/pairs/src/engine/schemas.ts`, `faces.ts` |
| A25-S-5 | Noted: a leave by a seat already out is unreachable through the framework. | — |
| A25-S2-1, A25-S2-2 | Fixed in the spec (owner decision). 02 §6.3, the SDK docs and the changesets say exactly what the kit checks; a flag-setting module must test that `perturbHidden` covers its hidden set; the stronger check is backlog. | 02 §6.3, `packages/sdk/src/contract.ts`, `docs/guides/writing-a-game.md`, 10 |
| A25-P-1 | Backlog (owner decision): a chores slice (one schema check per distinct view, sharded `games:verify`, a `test:games` job) before the pairs client installs pairs. | 10 §Pairs game |
| A25-P-2, A25-P2-3 | Fixed. Measured timing comments. | `games/pairs/src/kit.test.ts`, `oracle.test.ts` |
| A25-P-3, A25-P-4 | Fixed. The rules text on declining; no "Memory" in the package description, with a test. | `games/pairs/src/manifest.ts`, `package.json` |
| A25-P-5, A25-P2-2 | Fixed. `catalogSchema` pins every value, the default grid included. | `schemas.ts` |
| A25-P-6 to A25-P-11, A25-P2-5 | Fixed. Leave cases tested; coverage reports its samples and the reseed odds; one traced kit run; worst-case kinds tied to a list; the oracle independent of the view. | `games/pairs/src/` tests, `kit-hooks.ts` |
| A25-P2-4 | No change: the tracing map's memory use is noted in a comment. | `games/pairs/src/kit.test.ts` |
