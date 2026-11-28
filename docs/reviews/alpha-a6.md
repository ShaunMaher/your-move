# Alpha A6 review — resolutions

This record covers round 1 of the review of alpha slice A6, the "It's your turn" email nudges
(`alpha-a6-nudges`): the picky review (A6-P) and the security review (A6-S). Each line gives the
finding's ID, its outcome and where the fix lives. Owner decisions are marked as such. The spec
changes are folded into v0.9.21 (the README history line).

## Picky review (A6-P)

| ID | Outcome | Where |
|---|---|---|
| A6-P-1 | Fixed. `NudgeRepo.due` takes the installed (type, rules version) pairs from the registry and filters on them in SQL, so orphaned games never take a place in the queue. Tests: 100 orphaned seats waiting longer plus one normal seat, and the normal one is nudged (Node); an orphan is never listed and an empty list returns nothing (repository contract, both drivers). | `packages/server/src/db/nudge-repos.ts`, `sweep/nudges.ts`, `apps/node/src/nudges.test.ts`, `db/nudge-contract.ts` |
| A6-P-2 | Fixed (spec). 03 §7 says "never state, options, totals or standings (a move's points only as its `describe` text gives them)"; 08 T18 lists the turn email. | 03 §7, 08 T18 |
| A6-P-3 | Fixed (owner decision). Turning nudges on in a signed-in session removes an `unsubscribed` suppression of the address in the same batch; `bounced` and `complained` rows stay and keep suppressing. Surfacing those in Settings is M4's, with bounce handling (dated note in the roadmap's M4 section). Tests: all three reasons (repository contract) and end to end (Node). | `packages/server/src/db/auth-repos.ts`, 03 §7, 10 M4 |
| A6-P-4 | Fixed (owner decision). `createSweep` takes `nudgesPerRun`: 100 on Node, 10 on Workers. 09 §3 and `docs/deploy.md` say the Workers subrequest and D1-query budget per Cron Trigger invocation bounds it; the roadmap's "First Workers deployment" re-measures it. The queries are unchanged. | `packages/server/src/sweep/sweep.ts`, `apps/node/src/sweeper.ts`, `apps/worker/src/index.ts`, 09 §3, 10 |
| A6-P-5 | Fixed (spec). 03 §5.2's list of non-transition writes names `last_nudged_at`. | 03 §5.2 |
| A6-P-6 | Fixed. The vacuous `"hand"` check is gone; a words-game nudge is checked against both players' actual racks (joined several ways, case-insensitive) in its subject, text and HTML. The Worker cron test checks the invocation's outcome (now "ok" only when no step or nudge failed) and the cap counter the send path writes, beside the claim. The deleted-account test deletes a real account through the step-up flow first. | `apps/node/src/nudges.test.ts`, `tests/contract/src/worker.test.ts`, `apps/worker/src/index.ts` |
| A6-P-7 | Fixed with A6-S-3. | — |
| A6-P-8 | Fixed. `setEmailNudges` takes a union: on with an `emailId`, or off. `PATCH /api/v1/me` refuses turning nudges on for an account without an address (`400`); test. | `packages/server/src/db/repositories.ts`, `auth/routes.ts` |
| A6-P-9 | Fixed. `formatText` moved to the SDK's main entry (the client entry imports React, which the server must not), re-exported from `/client`; the sweep uses it and the registry (`GameRegistry.all()`, `GameType.versions`, built by the same `instanceGames` helper as `createApp`). A seat without a name shows "Seat n", as the game screens do. The web app's own name helpers can't be shared: `apps/*` may not be imported by packages (dependency rule `packages-not-to-apps`). | `packages/sdk/src/text.ts`, `packages/server/src/games/instance.ts`, `registry.ts`, `sweep/nudges.ts` |
| A6-P-10 | Fixed. Both logs use `constructor.name`. | `sweep/nudges.ts` |
| A6-P-11 | Fixed. "It has been waiting for you for over a day." | `email/templates.ts` |
| A6-P-12 | Fixed. Stored settings are read key by key; one unreadable value no longer resets the others. Test. | `auth/routes.ts`, `apps/node/src/nudges.test.ts` |
| A6-P-13 | Fixed. Q27 is in the resolved format. The commit with the footer-like body line is left as it is (no history rewrite); new commits avoid it. | `docs/spec/open-questions.md` |

## Security review (A6-S)

| ID | Outcome | Where |
|---|---|---|
| A6-S-1 | Fixed (owner decision). `LIMIT_NUDGE_EMAILS_PER_DAY` (default 200) counted through `rate_limits` before each claim; at the cap the run stops without claiming, and the crossing is alerted once with the existing instance-wide alert. 08 §4 row, 09 §1, Q27. Tests: cap of 1 with two due seats, one alert, nothing more on the next run, the rest after the window. | `auth/limits.ts`, `sweep/nudges.ts`, 08 §4, 09 §1 |
| A6-S-2 | Fixed (spec, owner decision). 09 §1.1: the rotation job must keep old `nudges` links resolvable through the `v1` `emailId`; the page stays the same either way. | 09 §1.1 |
| A6-S-3 | Fixed. The claim re-checks the seat, the game being `active` and the user's eligibility (nudges on, onboarded, not suspended or being deleted, not suppressed) in its one statement. Tests on both drivers: unsubscribe, suppression, suspension, deletion and a finished game between `due` and `claim`. | `db/nudge-repos.ts`, `db/nudge-contract.ts` |
| A6-S-4 | Fixed (owner decision). `users.email_id` is cleared whenever nudges turn off, in Settings or by an unsubscribe; 04 says it is set exactly while they are on. Tests. | `db/auth-repos.ts`, 04 |
| A6-S-5 | Fixed (spec, owner decision). 09 §5 and `docs/deploy.md` keep the unsubscribe query string out of edge logs. | 09 §5, `docs/deploy.md` |
| A6-S-6 | Fixed (spec, owner decision). 08 §4 records the unrated unsubscribe POST as a deliberate T13 exception, with the reasoning. | 08 §4, 05 §Email links |

## Round 2

Round 2 verified every round 1 resolution. Its new findings, with the owner's decisions:

| ID | Outcome | Where |
|---|---|---|
| A6-S2-1 / A6-P2-1 | Fixed (owner decision, reversing A6-P-3). Turning nudges on deletes no suppression. Nudge eligibility, in `due` and in the claim, is stopped only by `bounced` and `complained` rows; an `unsubscribed` row is about invite emails, and nudges have their own opt-out. The M4 note on showing a suppression in Settings stays, since bounces and complaints still stop nudges silently. Tests on both drivers and end to end. | `db/auth-repos.ts`, `db/nudge-repos.ts`, 03 §7, 04 `email_suppressions`, 10 M4, Q27 |
| A6-P2-2 | Fixed (owner decision). The room left is read without counting, only claimed nudges are counted, and the alert is raised once per fixed window through a counter of its own. Test: a day of 15-minute runs under saturation across midnight sends the cap plus at most one, counts exactly what it sent, and alerts once in each window. The daily caps allow about the cap per UTC day and up to about twice the cap in any 24 hours (wording corrected in round 3, A6-P3-3). | `auth/limits.ts`, `sweep/nudges.ts`, `apps/node/src/nudges.test.ts` |
| A6-S2-2 | Fixed (owner decision). `due` lists the least recently nudged first, then the longest waiting; a per-recipient daily cap `LIMIT_NUDGE_EMAILS_PER_USER_PER_DAY` (default 10) is read and counted the same way, with no alert. 08 §4, 09 §1, Q27. Tests for the order (both drivers) and the cap. | `db/nudge-repos.ts`, `sweep/nudges.ts`, 08 §4, 09 §1 |
| A6-P2-3 | Fixed (owner decision). A deleted account's seat is "Deleted player" and an unset name "New player", as 02 §5 and 04 say; every seated row gets one of these, so "Seat n" isn't used. 03 §7 agrees. The web app is unchanged (the owner files its divergence separately). Test. | `sweep/nudges.ts`, 03 §7 |
| A6-P2-4 | Fixed, with one deviation. 09 §3 states the per-statement arithmetic: at most 5 statements per run and 10 per nudge, counting each statement of a batch as a query. At the requested 5 nudges a run comes to 55, over the Free plan's per-invocation limit of 50 (check the current Cloudflare limits), so the Worker sends 4 per run (45). | `apps/worker/src/index.ts`, 09 §3, `docs/deploy.md`, 10 |
| A6-P2-5 | Fixed. The SDK changeset is a `patch`. | `.changeset/sdk-format-text-main-entry.md` |
| A6-P2-6 | Fixed. The Cron Trigger's outcome lives in `runScheduled`, unit-tested: a clean or capped run ends cleanly; a failed step, a failed nudge or a Worker that couldn't be built fails the invocation and calls `noRetry`. | `apps/worker/src/scheduled.ts`, `scheduled.test.ts` |
| A6-P2-7 | Fixed. A capped run reports and logs no `due` count. | `sweep/nudges.ts`, `sweep/sweep.ts` |
| A6-P2-8 | Fixed. 05's `PATCH /api/v1/me` row lists the `400`. | 05 §Auth & account |

## Round 3

Round 3 verified every round 2 resolution except one, A6-P3-1, and accepted the Worker's four
nudges per run (A6-P2-4).

| ID | Outcome | Where |
|---|---|---|
| A6-P3-1 | Fixed (owner decision). `due` returns at most one seat per recipient per page (`row_number()` over each recipient), and orders recipients by their most recent nudge in any game, then the seat's own last nudge, its wait and its id; window functions run on both drivers (repository contract on D1). Tests: a recipient at their own cap with two never-nudged seats waiting longest no longer keeps another recipient waiting, with two seats a run and with one; one seat per recipient and the recipient order on both drivers. 03 §7, Q27. | `db/nudge-repos.ts`, `db/nudge-contract.ts`, `apps/node/src/nudges.test.ts` |
| A6-P3-2 | Fixed. `suppress` upserts with precedence: `bounced` or `complained` replaces `unsubscribed`, never the reverse, and otherwise the first row stays; `created_at` is when the current reason was recorded (04). Repository contract test. | `db/nudge-repos.ts`, 04 |
| A6-P3-3 | Fixed. 08 §4, Q27 and this record say "about the cap per UTC day, up to about twice the cap in any 24 hours"; Q27 shows nudges at that worst case still fit the sender's daily quota beside sign-in codes and invite emails. | 08 §4, Q27 |
| A6-P3-4 | Fixed. The alert counter's key is `alert:<NAME>`, which no `checkLimits` key can be. | `auth/limits.ts` |
| A6-P3-5 | Fixed. The capped-run test checks that `noRetry` isn't called. | `apps/worker/src/scheduled.test.ts` |
