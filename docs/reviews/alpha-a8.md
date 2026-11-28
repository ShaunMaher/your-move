# Alpha A8 review — resolutions

This record covers rounds 1 and 2 of the review of alpha slice A8, the Web Push "your turn" and "game
over" notifications (`alpha-a8-push`): the picky review (A8-P) and the security review (A8-S).
Each line gives the finding's ID, its outcome and where the fix lives. Owner decisions are marked
as such. The spec changes are folded into v0.9.23 (the README history line).

## Security review (A8-S)

| ID | Outcome | Where |
|---|---|---|
| A8-S-1 | Fixed. On an endpoint conflict, the same user and session update the row; another user or session takes it over only when the keys sent equal the stored ones, and otherwise nothing changes, with the same `204`. Tests: same session updates in place; a new session of the same user and another user move only with equal keys (repository contract, both drivers); the route answers `204` and leaves the owner's row alone (Node). | `packages/server/src/db/push-repos.ts`, `db/repositories.ts`, `db/push-contract.ts`, `apps/node/src/push.test.ts`, 04, 05 |
| A8-S-2 | Fixed. `forUsers` joins `sessions` and keeps only live ones, by `liveSessionCutoffs`, which the session check now uses too, so the expiry rules live in one place. Tests: an idle-expired and an over-cap session's subscriptions aren't listed (repository contract); no push reaches a device of an expired session (Node). | `packages/server/src/auth/session.ts`, `db/push-repos.ts`, `push/notify.ts`, 03 §7, 04 |
| A8-S-3 | Fixed with A8-P-7: subscriptions are interleaved by recipient (each one's devices most recently useful first) before the 40 cut. Test. | `packages/server/src/push/notify.ts`, `push/notify.test.ts`, 03 §7 |
| A8-S-4 | Fixed with A8-P-6: `gen:vapid` writes nothing if either file exists, and removes the private key if writing the public key fails. Tests: only the private key exists; only the public key exists; the second write fails. | `scripts/src/vapid/generate.ts`, `generate.test.ts`, 09 §1 |

## Picky review (A8-P)

| ID | Outcome | Where |
|---|---|---|
| A8-P-1 | Fixed. A launch without a session unsubscribes the browser beside clearing the game keys; the return path and the per-device flags stay, as 06 §4 says. Test: an existing subscription and a signed-out launch, `unsubscribe()` called and no push request. | `apps/web/src/App.tsx`, `screens/Settings.test.tsx`, 06 §4, 07 §4 |
| A8-P-2 | Fixed (owner decision, Q28). The once-per-device offer also follows a successful accept of an invitation, on the game's screen, from the accept's tap; not after a failed accept, not without a server key, not twice. The offer is one component shared with the new-game flow. Tests. | `apps/web/src/PushOffer.tsx`, `screens/Game.tsx`, `screens/NewGame.tsx`, `screens/Game.test.tsx`, 03 §7, 07 §4, open questions Q28 |
| A8-P-3 | Fixed. Node test of the framework-only decline: Bo declines before acting, Ada gets "Bo declined the game, so it's over.", Bo gets nothing. | `apps/node/src/push.test.ts` |
| A8-P-4 | Fixed. When a refused permission takes the toggle away, focus moves to the section's heading. Test. | `apps/web/src/screens/Settings.tsx`, `Settings.test.tsx`, 07 §4 |
| A8-P-5 | Fixed. Eviction keeps the most recently useful, by `COALESCE(last_success_at, created_at)`. Test: a delivery saves the oldest subscription from eviction. | `packages/server/src/db/push-repos.ts`, `db/push-contract.ts`, 04 |
| A8-P-6 | Fixed with A8-S-4. | — |
| A8-P-7 | Fixed with A8-S-3. | — |
| A8-P-8 | Fixed. The body is cut by code point. Test with astral characters. | `packages/server/src/push/notify.ts`, `notify.test.ts`, 03 §7 |
| A8-P-9 | Fixed. `MAX_SUBSCRIPTIONS_PER_USER` lives with the endpoint rules. | `packages/server/src/push/endpoint.ts`, `push/routes.ts` |
| A8-P-10 | Fixed. The tunnel section says how to upgrade an existing deployment. | `docs/deploy.md` |

## Round 2 (A8-R2)

| ID | Outcome | Where |
|---|---|---|
| A8-R2-1 | Fixed. The decline test waits for the start's push before declining, so the two pushes can't arrive in either order; the file passed 20 runs in a row. | `apps/node/src/push.test.ts` |
| A8-R2-2 | Fixed (owner decision). A save from another user or session takes over an endpoint whose stored session is no longer live, whatever the keys; the eviction ranks rows of sessions that aren't live below every live one, so they go first. Both use `liveSessionCutoffs`. Tests on both drivers. | `packages/server/src/db/push-repos.ts`, `db/repositories.ts`, `push/routes.ts`, `db/push-contract.ts`, 04, 05 |
| A8-R2-3 | Fixed. `sendTransitionPushes` with five recipients of ten devices each, listed one recipient after another: 40 sent, eight to each. | `packages/server/src/push/notify.test.ts` |
| A8-R2-4 | Fixed. When the offer after an accept closes, focus moves to the screen's heading. Test. | `apps/web/src/screens/Game.tsx`, `Game.test.tsx`, 07 §4 |
| A8-R2-5 | Fixed (spec). 03 §7 says the body is cut to 240 code points; grapheme cutting was left out to keep it simple. | 03 §7 |
| A8-R2-6 | Fixed. The named lines are wrapped (comments, SQL, messages, test titles, the 03 and 07 paragraphs); the OpenAPI description of the upsert now matches the takeover and eviction rules. | `packages/server/src/db/push-contract.ts`, `db/push-repos.ts`, `scripts/src/vapid/generate.ts`, `packages/shared/src/push.ts`, 03 §7, 07 §4 |
