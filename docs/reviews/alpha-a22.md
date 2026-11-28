# Alpha A22 review (the `paths` engine): resolutions

This record covers the review of `alpha-a22-paths-engine`: the pure `paths` engine, rules version 1,
which passes the generic test kit at 2 to 8 players and the module rule tables (spec v0.9.43). The
package stays uninstalled until its client module ships. It had two rounds of the picky review
(A22-P, A22-P2) and of the security review (A22-S, A22-S2); the owner read `validate` and the
self-elimination rule and signed off. The full-mode kit, which CI doesn't run on an uninstalled game,
was run by hand: 35,000 games, no failures.

| ID | Outcome | Where |
|---|---|---|
| A22-S-1, A22-S2-1 | Fixed. `worstCase` costs what `validate` and `apply` trace, searches 150 games and keeps distinct positions; the spec calls it a heuristic. Worst p99 0.56 ms against 5 ms. | `games/paths/src/engine/kit-hooks.ts`, paths §7 |
| A22-S-2 | Fixed. A test that the hidden-state perturbation reorders the deck in every phase. | `kit-hooks.test.ts` |
| A22-S-3 | No change: once installed, `games:verify` runs the full kit in CI. | — |
| A22-S-4 | Fixed. The rules text and paths §3 say what self-elimination under the default rule reveals. | `games/paths/src/manifest.ts`, paths §3 |
| A22-S2-2 | Fixed. The extra self-eliminating input never duplicates a kept position. | `kit-hooks.ts` |
| A22-S2-3 | Noted: measured p99s are far under the budget. | — |
| A22-P-1 | Fixed in the spec: a game-ending move lists nobody as skipped; tested. | paths §3, `state.test.ts` |
| A22-P-2 | Fixed. A surviving mover counts as short at the token hand-over; tested. | paths §4, `state.test.ts` |
| A22-P-3, A22-P-4 | Fixed. `declined` listed; paragraph re-wrapped. | paths §5, §7 |
| A22-P-5, A22-P-6, A22-P2-1 | Fixed. Helper names and locations. | `games/paths/src/test-support.ts`, `engine/at.ts` |
| A22-P-7 | Fixed. View and record arrays bounded by construction. | `games/paths/src/engine/schemas.ts` |
| A22-P2-2 | No change: near-duplicate positions are acceptable for a heuristic. | — |
