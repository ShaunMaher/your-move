# M2b review — resolutions

This record covers round 1 of the review of M2b, the server half of sign-in (`m2b-signin`,
MR !14): the security review (S) and the picky review (P). Each line gives the finding's ID, its
outcome and where the fix lives. The spec changes are in v0.9.15 (the README history line).

## Security review (S)

| ID | Outcome | Where |
|---|---|---|
| S-1 | Fixed (with P-18). `/otp/request` checks the client IP's buckets on their own first; a request refused for its IP answers `429` and charges no per-email counter. Test: twelve refused requests leave the address its full hourly allowance. | `packages/server/src/auth/otp.ts`, `apps/node/src/auth-review.test.ts`, 06 §3 |
| S-2 | Fixed. A server fault that wraps a cause (the database driver's query error) or is a parse error is logged by class, stack frames and the cause's class or code only, never its message. Tests: a failing single statement and a failing batch; neither the address nor the query text reaches the log. | `packages/server/src/app.ts`, `apps/node/src/auth-review.test.ts` |
| S-3 | Fixed (with P-13; owner decision). `TURNSTILE_*` refuses to start until enforcement is built; the global caps stay, with an alert. Accepted risk F-12, review by M4. | `packages/server/src/config/parse.ts`, `docs/security/findings.md`, 10 M2 |
| S-4 | Fixed, by a different route than the owner's first choice, with the reason here. New accounts per IP are judged and counted at the verifying client: an unknown address verifying from a full bucket gets `INVALID_CODE` and no account. Storing the requester's buckets on the challenge row needs a migration, and issue #13 gates the first migration after `0000_init` on its migration-safety items, which don't fit this round; checking at the verifying client closes the same gap without one. `/otp/request` still reads the counter, so it stays silent early. Counted only when the verify really inserted the row (P-17). | `packages/server/src/auth/otp.ts`, `routes.ts`, 08 §4 |
| S-5 | Fixed. A never-emailed challenge burns nothing (the statement runs, its flag matching no row), and only emailed challenges hold a place among the newest three. Test: three never-emailed challenges leave a person's real code working. | `packages/server/src/db/auth-repos.ts`, `apps/node/src/auth-review.test.ts` |
| S-6 | Fixed (with P-7). Timing is now measured for suspended, per-email-limited, new-accounts-limited and over-the-global-cap addresses against known ones (200 samples a side, background work drained between measurements). The power check plants one extra indexed SELECT on the known path and must be detected (`|z| > 4`). Residual: an unknown address from a full new-accounts bucket measured about 2% quicker than a known one locally (`|z|` about 3, below the one-SELECT difference); the per-email-limited path is quicker than an unlimited one because it creates no challenge, which says nothing about the account. | `apps/node/src/auth-parity.test.ts` |
| S-7 | Fixed. Addresses with format characters (bidi controls, zero-width, word joiner, soft hyphen) are refused. | `packages/server/src/accounts/email.ts` |
| S-8 | Fixed. Local-dev mode binds to loopback, and `/__dev/emails` answers only requests whose `Host` is `PUBLIC_URL`'s. | `apps/node/src/main.ts`, `packages/server/src/app.ts` |
| S-9 | Fixed with P-11. | see P-11 |
| S-10 | Accepted risk F-13, next to F-1, review by M4. | `docs/security/findings.md` |
| S-11 | Done in M2b (P-8): cookie plus bearer is refused on every route; 10 M3 says so. | 10 M3 |

## Picky review (P)

| ID | Outcome | Where |
|---|---|---|
| P-1 | Fixed. 10 M2 lists each deferral and its milestone (SMTP pending Q26, `/me/sessions` in M2c, `settings` in M4, Turnstile refused until M4, deletion steps in M3) and says M2 can't be accepted until a provider sends. Q26 asks Shaun about MIT-0. 09 §2 ties `smtp` to Q26. | 10 M2, `open-questions.md`, 09 §2 |
| P-2 | Fixed. The suspended test verifies a real code and expects `INVALID_CODE` and no cookie. | `apps/node/src/auth-review.test.ts` |
| P-3 | Fixed. The dropped-request test also verifies the oldest live code. | `apps/node/src/auth-review.test.ts` |
| P-4 | Fixed. `revokeAll` is checked against tokens of the user, their agent and someone else, on both drivers. | `packages/server/src/db/auth-contract.ts` |
| P-5 | Fixed. Account deletion is checked across tokens (by owner and by creator), blocks and past opponents both ways, the agent cascade, one nulled `account_deleted` event after a repeat, and an untouched bystander, on both drivers. | `packages/server/src/db/auth-contract.ts` |
| P-6 | Fixed. 50 parallel `verifyCode()` calls through the core, on Node and D1: at most 5 attempts evaluated, exactly 1 `ok`. | `packages/server/src/db/auth-contract.ts` |
| P-7 | Fixed with S-6. | see S-6 |
| P-8 | Fixed. Cookie plus bearer is refused in the request rules for every `/api/*` route. | `packages/server/src/http/request-rules.ts` |
| P-9 | Fixed. An empty body with a content type counts as no input, so no-input endpoints accept it. | `packages/server/src/http/request-rules.ts` |
| P-10 | Fixed. A successful verify deletes the valid session the browser presents before creating the new one. | `packages/server/src/auth/routes.ts` |
| P-11 | Fixed (with S-9). An unbuilt provider logs at error level at startup; each message gets one error-level alert and the send resolves. | `packages/server/src/email/` |
| P-12 | Fixed. Instance-wide limits alert once, on the request that first crosses them. | `packages/server/src/auth/otp.ts` |
| P-13 | Fixed with S-3. | see S-3 |
| P-14 | Fixed. Node warns once when the last 100 client addresses were all private or loopback under `TRUST_PROXY=false`. | `apps/node/src/platform.ts` |
| P-15 | Fixed. `ADMIN_EMAILS` entries must pass the sign-in normaliser and are stored normalised by it. | `packages/server/src/config/parse.ts` |
| P-16 | Fixed. The OpenAPI document has the `sessionCookie` security scheme on session routes, verify's `Set-Cookie` header and `getMe`'s `400`. | `packages/shared/src/auth.ts`, `packages/server/src/app.ts` |
| P-17 | Fixed with S-4. | see S-4 |
| P-18 | Fixed with S-1. | see S-1 |
| P-19 | Fixed differently. The JSON rule now reads the body itself (at most 16 kB, after the body limit) instead of framing headers, because in-process and HTTP/2 requests may have no `Content-Length` while the Node adapter gives every non-GET request a body stream, empty or not; `body !== null` alone would refuse body-less `DELETE`s on Node. | `packages/server/src/http/request-rules.ts` |
| P-20 | Fixed in part. Done: the error-code union from `ErrorCode`, settings parsed with `UserSettingsSchema`, `IssueOutcome.user` removed, `RequestOrigin` renamed `ClientBuckets`, `UserRecord.email` branded so the casts are gone, three unused exports dropped. Rebutted: `LIMIT -1` (Drizzle emits no `LIMIT` for `-1`, and SQLite rejects `OFFSET` without one; the code says so); telling burned challenges from used ones needs a column, so a migration (issue #13), and nothing reads the difference yet. | `packages/server/src/auth/`, `db/` |
| P-21 | Fixed. Display names refuse tabs and line breaks (control characters) before collapsing space separators. | `packages/server/src/accounts/display-name.ts`, 06 §5.1 |
| P-22 | Fixed (owner decision). U+200D is allowed only between two emoji code points (a skin-tone modifier or variation selector may sit before it); 06 §5.1 says so. | `packages/server/src/accounts/display-name.ts`, 06 §5.1 |

## Round 2

Round 2 reviewed HEAD 40e0a12. The security review passed; the remaining picky and security notes (P2-3 to P2-7, S2-1, S2-3, S2-4) are filed as an issue.

| ID | Outcome | Where |
|---|---|---|
| P2-1 | Fixed. The P-21 change let the Unicode line and paragraph separators (U+2028, U+2029) through; display names refuse them again, and 06 §5.1 names them. Tests: the validator and `PATCH /me`, which stores nothing. | `packages/server/src/accounts/display-name.ts`, `apps/node/src/auth-review.test.ts`, 06 §5.1 |
| P2-2 | Fixed. The core race test holds every `live()` result at a barrier until all 50 verifies have read it, so all 50 race to `attempt()` on both drivers, and it asserts exactly 5 evaluated and exactly 1 `ok`. Checked that it can fail: with `attempt()` ignoring the cap it goes red on Node and D1 (50 evaluated). | `packages/server/src/db/auth-contract.ts` |
| S2-2 | Fixed. The burn predicate compares the flag with each row (`emailed = flag`), so SQLite runs the subquery on every path; behaviour is unchanged, as every selected row has `emailed = 1`. The new-accounts-limited timing gap didn't move (z about -2.9 before and after, median about 1.5 to 3% quicker), so its cause lies elsewhere; it stays within the test's bound and is noted in the follow-up issue. | `packages/server/src/db/auth-repos.ts` |

## Round 3

Round 3 reviewed HEAD 8ce3822 (both reviewers: merge). The fixes are in the follow-up branch `m2b-round3`; the spec change is v0.9.17 (06 §3.2, 04 `rate_limits`).

| ID | Outcome | Where |
|---|---|---|
| R3-P-1 | Fixed. `pnpm test:timing` runs only the timing file; `pnpm test` skips it (the root Vitest config), so the `test` job needs no `--exclude` for it and `test:timing` calls the script. CLAUDE.md lists the script and says coders run it before handing off sign-in changes; ADR 0006 says the same. The file is still typechecked and linted (only the test run skips it). | `package.json`, `vitest.config.ts`, `.gitlab-ci.yml`, `CLAUDE.md`, ADR 0006 |
| R3-P-2 | Fixed. 06 §3.2 says a request that sends nothing adds 1 to a separate, never-read counter and schedules a do-nothing background task; 04 lists the `all` and `silent` keys. | 06 §3.2, 04 `rate_limits` |
| R3-P-3 | Fixed. The exact-parity test records each hit's limit name, key (per-address and per-client hashes as `<hash>`; `all` and `silent` kept) and amount, so a silent path writing `all` fails it (checked by temporarily making the silent key `all`). A deterministic check counts `waitUntil` calls: exactly one on every path that answers 202, none on the 429 path. | `apps/node/src/auth-parity.test.ts`, `apps/node/src/test-harness.ts` |
| R3-P-4 | Fixed. The header's ranges say they were observed over 20 runs, not guaranteed, with the new-accounts-limited (-1.54%) and per-email-limited vs unlimited (-3.31%, not asserted) ranges corrected and the margins recomputed (1.46 points inside the bound; the weakest planted SELECT 2.08 points above it). | `apps/node/src/auth-timing.test.ts` |
| R3-P-5 | Fixed. `signedRankZ` is removed; the report prints shifts only. | `apps/node/src/auth-timing.test.ts` |
| R3-P-6 | Fixed. "CI runners" says `test:timing` measures on the arm64 runner, that other pipelines' jobs can share it unless the runner's concurrency is 1, and that this is the operator's runner setting, not recorded in the repository. | `docs/deploy.md` |
| R3-S-1 | Fixed (owner decision: keep the cap counted on `wouldSend`). 06 §3.2 says parity covers the work before the response and that what happens afterwards on the new-accounts-limited path differs by design (08 §4); accepted risk F-14. | 06 §3.2, `docs/security/findings.md` F-14 |
| R3-S-2 | Fixed (docs only). F-12 says a flood far over the cap keeps it closed for up to about two windows, because the counter is a sliding estimate and refused requests still count. | `docs/security/findings.md` F-12 |
| R3-S-3 | Recorded as accepted risk F-14: the known path's residual slowness, the timing gate's floor, the call-recording test as the primary control, review at M4 or if the instance grows. | `docs/security/findings.md` F-14 |
| R3-S-4 | Fixed. The call-recording tests now also compare: the IP-limited 429 path (known against unknown address, and what it does), verify with no live challenge, verify past the per-email failure lockout, a known address that is per-email-limited, and a suspended address from a full new-accounts bucket, each with its counterpart. | `apps/node/src/auth-parity.test.ts` |
| R3-S-5 | Fixed. `.tmp-in-memory` makes a directory of its own with `mktemp -d /dev/shm/ci-tmp.XXXXXX` (short, for tsx's socket path), after the free-space guard. | `.gitlab-ci.yml` |

## Round 4 (review of the round 3 fixes)

| ID | Resolution | Where |
|---|---|---|
| R4-1 | Fixed. The header's last observed range was truncated; it now reads −3.31% to −1.29% and says which values came from later review runs. | `apps/node/src/auth-timing.test.ts` |
| R4-2 | Fixed (comment). The Docker executor gives each job container its own `/dev/shm`, so the per-job directory needs no clean-up. | `.gitlab-ci.yml` |
| R4-3 | Resolved at merge: the spec version numbers of the parallel alpha branches are renumbered in merge order. | `docs/spec/README.md` |
