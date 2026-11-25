# Alpha A2 review — resolutions

This record covers round 1 of the review of alpha slice A2, the game framework core
(`alpha-a2-framework`): the security review (S) and the picky review (P). Each line gives the
finding's ID, its outcome and where the fix lives. The spec changes are in v0.9.17 (the README
history line). Owner decisions are marked.

## Security review (S)

| ID | Outcome | Where |
|---|---|---|
| A2-S-1 | Fixed (owner decision: build it now). The inbound invitation cap of 06 §6.7: from creators who aren't past opponents, a user receives at most 1 invitation a day per creator and 3 a day in total; over the cap the invitation is created `hidden`. Counted in `rate_limits` keyed by the target's `emailId` (with the creator's id for the per-creator count), for every typed address with the same lookups and writes, so the create response and the work are the same either way (Q3); a past opponent's invitation reads the counters without adding to them. New limits `LIMIT_INVITATIONS_RECEIVED_PAIR_DAY` (1) and `LIMIT_INVITATIONS_RECEIVED_DAY` (3). A lobby's presentation now reads only joined rows' users, which keeps those reads the same too. Tests: per creator, in total, past opponents exempt, a hidden invitation listed only under `?invitations=hidden` and still acceptable, and parity (the same repository calls and the same response for an invitee under the cap, over it, a past opponent, an un-onboarded account and no account). | `packages/server/src/games/create.ts`, `auth/limits.ts`, `db/auth-repos.ts`, `games/present.ts`, `apps/node/src/games-review.test.ts`, 06 §6.7, 09 §1 |
| A2-S-2 | Fixed (with A2-P-4). The secrecy test lists the app's registered `/api/v1/games*` and catalog routes and fails if one wasn't exercised. At every step it rewrites what each seated viewer can't see in the stored state (the other seats' pieces, the bag or deck order) and requires every read to answer that viewer byte for byte as before; a planted leak of one hidden tile turns it red. Other seats' pieces and the bag or deck are secrets of their own. It exercises create, start, cancel, seen, a lobby decline, the frozen `declined` ending with two viewers, refusals, strangers' `404`s, and real word plays found in the built-in list, with previews and a swap. | `apps/node/src/games-secrecy.test.ts`, `apps/node/src/test-harness.ts` |
| A2-S-3 | Fixed (with A2-P-12). Remembered options are written with `json_set` on `lastOptions[type]` and `lastGameType` only (`UserRepo.rememberGameOptions`); the generic user update no longer sets `settings`. Tests: a setting changed while a game is created survives; the repository on both drivers. | `packages/server/src/db/auth-repos.ts`, `games/create.ts`, `apps/node/src/games-review.test.ts`, `db/repository-contract.ts` |
| A2-S-4 | Fixed (owner decision: lazy expiry). Any read or write of a lobby past its 14 days first applies the expiry transition (`expired`, `ended_at` when it fell due, typed addresses cleared); listing or creating games first expires the caller's overdue lobbies (at most 100 a request). 03 §8 records this as the one write a read may make. Residual: a lobby nobody involved ever reads again keeps its typed addresses until the sweep exists (M3). Tests: before and after the 14 days, accept and start refused once overdue, the list, the live-game count. | `packages/server/src/games/expiry.ts`, `lifecycle.ts`, `routes.ts`, `db/repos.ts`, `apps/node/src/games-review.test.ts`, 03 §8 |
| A2-S-5 | Fixed. Every function of a definition the registry hands out rethrows as an `EngineFault` with a fixed message; the app logs it by game type, member, the original's class and its stack frames, never the message. Test: an engine that throws with a hidden hand in its message; the log and the response don't contain it. | `packages/server/src/games/engine-fault.ts`, `registry.ts`, `app.ts`, `apps/node/src/games-review.test.ts` |
| A2-S-6 | Fixed (with A2-P-9). The negative cache wraps the whole word-list load, the size and hash check included; the timeout stays around the runtime's load so a hung load leaves the provider's cache. Test: a mismatched list is fetched and hashed once per 30 s. | `packages/server/src/games/resources.ts`, `units.test.ts`, 03 §10 |
| A2-S-7 | Noted, not changed. The live-game caps are read before the insert, so concurrent creates can pass them together; the atomic daily limits (30 games a day, 5 a pair) bound how far. Said in the code. | `packages/server/src/games/create.ts` |
| A2-S-8 | Fixed (with A2-P-18). The dictionaries' unversioned `index.json` is no longer under `/assets/`: Node doesn't serve it (it reads it from disk; no client needs it), and the Worker's copy is at `/dictionaries/index.json`, which Cloudflare's default revalidates. The Worker's assets drop the `.gz` and `.br` copies, which Cloudflare's own compression makes useless. Tests: Node answers `404` for the index; the Worker publishes exactly the word list under `/assets/dictionaries/` and the index outside it. | `apps/node/src/server.ts`, `apps/worker/scripts/prepare-assets.ts`, `apps/worker/src/dictionaries.ts`, `apps/node/src/server.test.ts`, `tests/contract/src/worker.test.ts`, 03 §10 |
| A2-S-9 | Recorded for A4. The catalog's `icon` is rendered only as an image from a `data:` URL (`<img src="data:image/svg+xml,…">`), never inline; 05 and the OpenAPI description say so. | 05 `GET /api/v1/catalog`, `packages/shared/src/games.ts` |

## Picky review (P)

| ID | Outcome | Where |
|---|---|---|
| A2-P-1 | Fixed. `yourInvitation` and the `?invitations=` filters count an `invited` row only while its game is a `lobby`. Tests: a cancelled lobby's normal and hidden invitations. | `packages/server/src/games/present.ts`, `db/repos.ts`, `apps/node/src/games-review.test.ts`, 05 |
| A2-P-2 | Not built (owner decision: onboarding claims stay in M4). 05 and 02 §4 say that until then only an onboarded account can be played with by address, and that clients tell the creator the other person must have signed in first (the A4 players step). | 05 `POST /api/v1/games`, 02 §4 |
| A2-P-3 | Fixed. A type-level test checks, both ways, every place a route registers an SDK schema (the envelope, its players, `ListSummary`, `Text`, and the submit result's game and view) against the generated client, as JSON carries the types. It found the drift: `options`, `view` and `record` were documented optional; they now refuse `undefined`, so the document marks them required. | `packages/api-client/src/sdk-types.test.ts`, `packages/sdk/src/api.ts`, `packages/shared/src/games.ts`, `.changeset/sdk-envelope-options-present.md` |
| A2-P-4 | Fixed with A2-S-2. | see A2-S-2 |
| A2-P-5 | Fixed. `createApp` takes an optional random source factory that runtimes never pass; WebCrypto is built in one place (`cryptoRandom`). The game test harness plays from a seeded source, prints the seed when a test fails, and `GAME_SEED` replays it. Test: the same seed deals the same game. | `packages/server/src/games/random.ts`, `app.ts`, `apps/node/src/games-support.ts`, 03 §4 |
| A2-P-6 | Fixed. A member's own transition raises their unread marker to the version it creates, in the same transition; a new invitation starts at `-1`, so it is unread until seen. Test: invitation, accept and move. | `packages/server/src/games/routes.ts`, `create.ts`, `apps/node/src/games-review.test.ts`, 04 `last_seen_version` |
| A2-P-7 | Fixed. Every request of a race loads the game behind a barrier before any writes, so all reach `applyTransition`; the suite requires `stale` for every loser and checks that none of a loser's writes landed (its own seen marker included). Removing the version guard or the token guard turns it red on Node. | `packages/server/src/games/race-contract.ts` |
| A2-P-8 | Fixed. The contract suite seeds two signed-in players in each runtime's own database (the contract configuration sends no email) and previews and plays an opening word from the built-in list on Node and in workerd, so the Worker's `ASSETS` loader runs; breaking it turns the test red. | `tests/contract/src/suite.ts`, `node.test.ts`, `worker.test.ts`, `global-setup.ts` |
| A2-P-9 | Fixed with A2-S-6. | see A2-S-6 |
| A2-P-10 | Fixed (05 kept). The download URL is the envelope's `resources[].downloadUrl`; words §9.4 and the 05 catalog row no longer suggest the catalog carries one. | words §9.4, 05 |
| A2-P-11 | Fixed. The OpenAPI document gives every rate-limited game write a `429` and names `GAME_UNAVAILABLE` in every transition's `409`. A test checks both on every game write route. | `packages/shared/src/games.ts`, `routes.test.ts` |
| A2-P-12 | Fixed with A2-S-3. | see A2-S-3 |
| A2-P-13 | Fixed. `apps/node` builds the dictionaries' served layout in a global setup when it is missing, and the harness gives apps without games no dictionaries. Checked by deleting `packages/dictionary/generated` and running `vitest --project apps/node`. | `apps/node/vitest.config.ts`, `src/test-global-setup.ts`, `src/test-harness.ts` |
| A2-P-14 | Fixed. The race suite takes the game from its caller (installed games, a type and a legal move from a seat's view); it names no game. | `packages/server/src/games/race-contract.ts`, `apps/node/src/db/sqlite.test.ts`, `tests/contract/src/d1-repositories.test.ts` |
| A2-P-15 | Fixed. Tests: the creator declining before acting in a game that continues, an automatic start that `validateStart` refuses while the accept still answers `200`, and `404`s for a stranger's start, accept and cancel. | `apps/node/src/games-review.test.ts` |
| A2-P-16 | Fixed. The list selects the columns it shows, the state only while `active` and only the viewer's own final summary (extracted in SQL). Test on both drivers. | `packages/server/src/db/repos.ts`, `repositories.ts`, `games/present.ts`, `db/repository-contract.ts` |
| A2-P-17 | Fixed. The example's kit test has an explicit 60 s budget with its measurements beside it (ADR 0004). | `games/example/src/kit.test.ts` |
| A2-P-18 | Fixed with A2-S-8. | see A2-S-8 |
| A2-P-19 | Fixed. History's `via` answers what is stored, `system` included (an additive enum value). | `packages/shared/src/games.ts`, `games/routes.ts`, 05 |
| A2-P-20 | Fixed. One game-with-view reader instead of two near-copies; `/actions` uses the describe text the transition computed; an unused export made private. | `packages/server/src/games/routes.ts`, `lifecycle.ts` |
| A2-P-21 | Fixed. 03 §10 no longer describes bundling word lists as current, and says what the negative cache covers; the README keeps v0.9.17 (renumbered at merge). | 03 §10, README |

## Noticed while fixing

- The Worker answers a request for a missing file under `/assets/` with the SPA shell, `200`, and
  the `_headers` rule's immutable `Cache-Control`, also for a non-navigation fetch; Node answers
  `404` (03 §9). It predates A2 and isn't changed here; it is raised for the first Workers
  deployment.
- oasdiff against `main` reports no breaking change. Against this slice's first round it flags
  history's new `via` value (A2-P-19) as `response-property-enum-value-added`; the history
  endpoint has never shipped, so nothing depends on the narrower set.

# Round 2

Round 2 of the review of the same slice: the security review (S2, merge with lows) and the picky
review (P2, changes required). Owner decisions are marked. Accepted risks are in
`docs/security/findings.md` (F-15 to F-18).

## Security review (S2)

| ID | Outcome | Where |
|---|---|---|
| A2-S2-1 | Accepted risk (owner decision), F-17: the stranger allowance counts creations, so cancelled invitations still use slots. The planned fix counts live `invites` rows (Q3-safe); reviewed at M4, before invitation emails ship. The app's Hidden invitations section arrives with slice A4. | `docs/security/findings.md` |
| A2-S2-2 | Accepted risk (owner decision), F-18: the Worker's answer to a missing `/assets/*` file. Not changed now; the fix and the test change it needs are written down; reviewed before the first Workers deployment. | `docs/security/findings.md` |
| A2-S2-3 | Recorded: F-15 (the live-game caps race, A2-S-7), F-16 (the lazy-expiry residual of A2-S-4), with F-17 and F-18 above. | `docs/security/findings.md` |
| A2-S2-4 | Fixed. The secrecy test repeats the same preview and the same illegal action as each viewer in every read round, before and after the perturbation, and requires identical bodies. A negative control wraps the example game with a view that leaks the other seat's hand and requires `unchangedByHiddenState` to fail. Typed addresses are checked per game: every `invitedAs` must match an `invite_email` that game's own rows hold and be shown to its creator, and every address in a body must be one of them (bodies containing `invitedAs` are no longer skipped). | `apps/node/src/games-secrecy.test.ts` |
| A2-S2-5 | Fixed. `start` and `accept` refuse (`WRONG_STATUS`) when `now` is at or past `createdAt` plus the lobby lifetime, whatever the stored status says. Tests: both at the boundary and one moment before it. | `packages/server/src/games/lifecycle.ts`, `units.test.ts`, 03 §8 |
| A2-S2-6 | Fixed, by wrapping. The fault boundary also wraps `parse`, `safeParse` and their async forms on a definition's schema members, so an exception from a refinement is an `EngineFault` (logged without its message). Tests: a throwing action schema, a well-behaved schema, a function member. | `packages/server/src/games/engine-fault.ts`, `units.test.ts` |

## Picky review (P2)

| ID | Outcome | Where |
|---|---|---|
| A2-P2-1 | Fixed. The contract test no longer assumes a rack spells a word: it tries up to 25 fresh games (new players, so no pair limit) until one does, and fails with a clear message otherwise. The same assumption in the secrecy suite's words test is gone too (an opening that can't play passes and later turns make up the plays), which a repeat run showed failing about 1 in 16. | `tests/contract/src/suite.ts`, `apps/node/src/games-secrecy.test.ts` |
| A2-P2-2 | Fixed. 06 §6.4 says the inbound cap is counted once, at creation, for every typed address; the M4 claim reads the stored `delivery` and counts nothing again. | 06 §6.4 |
| A2-P2-3 | Fixed. Lazy expiry applies only when the caller holds a row in the game; a stranger's `404` never writes. 03 §8 now says expiry bumps the version (members see the game unread; a request in flight with the earlier `expectedVersion` gets `STALE_GAME`) and the per-request bound is 20 overdue lobbies, oldest first. Tests: a stranger's read leaves the row unchanged and a member's read expires it; the batch bound (20 of 50 expired by one create). | `packages/server/src/games/expiry.ts`, `routes.ts`, `apps/node/src/games-review.test.ts`, 03 §8 |
| A2-P2-4 | Recorded, not changed (owner decision): commit subjects over 72 characters and `f196c64` not typechecking on its own stay as history. | this record |
| A2-P2-5 | Fixed. A `@ts-expect-error` case assigns a drifted pair to the check, so a check that stopped rejecting would leave an unused directive and fail `tsc`. | `packages/api-client/src/sdk-types.test.ts` |
| A2-P2-6 | Fixed. 03 §4 says `@your-move/server/testing` and `@your-move/node/db` are test-only exports; the Node adapter's header says so at its `./db` export (JSON has no comments). | 03 §4, `apps/node/src/db/sqlite.ts` |
| A2-P2-7 | Fixed. A `GAME_SEED` that is not an integer throws a clear error. Test: `12abc` refused, `42` replayed. | `apps/node/src/games-support.ts`, `games-review.test.ts` |
| A2-P2-8 | Fixed. The `§` in `tests/contract/package.json` is as it was on `main`. | `tests/contract/package.json` |
| A2-P2-9 | Noted. The example kit test's 60 s budget was measured locally; it is to be re-measured from a CI run and the comment's figures replaced. | `games/example/src/kit.test.ts`, ADR 0004 |
