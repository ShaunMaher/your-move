# Alpha A24 review (the `paths` client and installing paths): resolutions

This record covers the review of `alpha-a24-paths-client`: the `paths` board UI and paths installed as the instance's second game (spec v0.9.47). It had two rounds of the picky review (A24-P, A24-P2) and of the security review (A24-S, A24-S2); the owner read the shared self-elimination rule and signed off.

Owner decisions:
- the rule is exported from the engine and shared with the client (P-2);
- the e2e elimination is asserted, and the game keeps playing until one happens (P-3, P2-3: seven tiles can't eliminate from any start, pinned in a test);
- squares are in pt, touch targets at least 44 CSS px (P-5, P2-4);
- one-tap notch placement for the alpha (P-6).

| ID | Outcome | Where |
|---|---|---|
| A24-P-1, A24-P2-1 | Fixed. A property test over seeded games checks the view-side rule against `validate` and `legalPlacements`. | `games/paths/src/client/rule.test.ts` |
| A24-P-2, A24-S2-1 | Fixed. One `selfElimination` in the engine, used by `validate` and the client; the hand is searched only under `avoidIfPossible` when the placement eliminates. | `games/paths/src/engine/rules.ts` |
| A24-P-3, A24-P2-2, A24-P2-3 | Fixed. The e2e asserts an elimination (playing up to eight turns for one), reads who is out from every page, and resigns only while more than one is left. | `tests/e2e/src/paths.spec.ts`, `rule.test.ts` |
| A24-P-4, A24-P-5, A24-P2-4 | Fixed. Every marker-phase button is at least 44 CSS px; squares stay `min(56 pt, …)`. | `games/paths/src/client/styles.ts`, paths §8 |
| A24-P-6 | Recorded (owner decision): one-tap notch placement, with the trade-off in paths §8. | paths §8 |
| A24-P-7 | Fixed. Touch emulation in the e2e; the M5 acceptance wording; the writing-a-game guide revision deferred to M5's close. | `paths.spec.ts`, 10 §M5 |
| A24-P-8 | Fixed. The 150 s e2e budget is marked provisional until measured in CI. | `tests/e2e/src/budgets.ts`, ADR 0004 |
| A24-P-9, A24-P-10, A24-P2-5, A24-P2-6 | Fixed. Readability, a transparent board on the shell's page, cited colours, §8 wording. | `plan.ts`, `styles.ts`, paths §8 |
| A24-P2-7 | No change: the duplicate-name player list states the marker look twice, harmlessly. | — |
| A24-S-1 | Fixed. The whole replay stays within 90 frames; property-tested over long replays. | `games/paths/src/client/plan.ts` |
| A24-S-2, A24-S2-2 | Fixed. Shared display names carry the marker look in the board's text and history. Look-alike characters remain the accepted 06 §5.1 residual. | `games/paths/src/client/text.ts` |
| A24-S-3, A24-S2-3 | Fixed. The `crowd` fixture collects every player's violations, surfaces collection errors, and closes every context. | `tests/e2e/src/fixtures.ts` |
