# Alpha A15 review: resolutions

This record covers the review of alpha slice A15, the rematch (`alpha-a15-rematch`): two rounds
of the picky review (A15-P, then A15-R2) and two of the security review (A15-S, then A15-S2).
Each line gives the finding's ID, its outcome and where the fix lives.

The coder's three departures from the brief were accepted: a caller who declined or left the
rematch gets 404 like any non-member; the `rematch` field carries the viewer's place in it
(`you`); and resolved options must resolve to themselves (02 §2.1 rule 10).

## Picky review

| ID | Outcome | Where |
|---|---|---|
| A15-P-1 | Fixed. 03 §5.2 lists the rematch link among the writes that aren't transitions, with its guard, and requires the rematch race tests. | 03 §5.2 |
| A15-P-2 | Fixed. A rematch that ended unplayed may be replaced, and then shows as no rematch. | `packages/server/src/db/repos.ts`, `games/lifecycle.ts`, `games/present.ts`, repository contract, 04, 05, 06 §6.11, 07 |
| A15-P-3 | Fixed. Only players who acted and still have an account are carried over; the seat count shrinks to fit, and below the module's minimum the answer is `REMATCH_UNAVAILABLE`. | `packages/server/src/games/routes.ts`, 05, 06 §6.11 |
| A15-P-4 | Fixed. Rule 10 is in the game-writing guide and the `resolveOptions` documentation. | `docs/guides/writing-a-game.md`, `packages/sdk/src/contract.ts` |
| A15-P-5 | Fixed. The kit compares against a snapshot and passes a copy; a module that changes its input fails. | `packages/testkit/src/combos.ts` |
| A15-P-6 | Fixed. Tests for the accept's retry and a race loser who holds an invitation. | `apps/node/src/rematch.test.ts` |
| A15-P-7 – P-15 | Fixed. Race test proof, refetch after a refusal, busy labels, the shared lobby expiry, a narrower read, ADR 0004's figures, an M3 token item, texts. | as committed |
| A15-R2-1 | Fixed. Every `declined` ending counts as unplayed; `cancelled` and `expired` only with no action logged. | `packages/server/src/db/repositories.ts`, repository contract, 04, 05, 06 |
| A15-R2-2 | Fixed. A lost race with no live rematch tries once more, then answers `STALE_GAME`. | `packages/server/src/games/routes.ts`, tests |
| A15-R2-3 | Fixed. Top-level option keys ending in `Version` are reserved for versions. | 02 §2.1, the game-writing guide |
| A15-R2-4 – R2-7 | Fixed. Texts and comments. | as committed |

## Security review

| ID | Outcome | Where |
|---|---|---|
| A15-S-1 | Open until M4: recorded with Q29 and in 08 T20 (blocks can't be written before M4). | `docs/spec/open-questions.md`, 08 T20 |
| A15-S-2 | Fixed. Version keys are accepted only as non-negative integers, and are never remembered. | `games/words/src/engine/options.ts`, `packages/server/src/games/settings.ts` |
| A15-S-3 | Fixed with A15-P-2. | as above |
| A15-S-4 | Deferred to M3, when tokens exist: an acceptance item in 10 and a marker in the code. | 10 M3, `packages/server/src/games/routes.ts` |
| A15-S-5 | Accepted as specified in 06 §6.11. | — |
| A15-S-6 | Fixed with A15-P-4: a module must ignore version keys, never honour them. | as above |
| A15-S2-1 | Fixed. An operator's cancel never counts as unplayed. | `packages/server/src/db/repositories.ts`, `games/lifecycle.ts`, 04 |
| A15-S2-2 | Fixed. A test that repeated rematches stop at the per-pair limit. | `apps/node/src/rematch.test.ts` |
| A15-S2-3 | Accepted. The overdue lobby's expiry on a rematch press is documented in 05. | — |
