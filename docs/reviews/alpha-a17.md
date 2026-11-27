# Alpha A17 review: resolutions

This record covers the review of alpha slice A17, email invites pulled forward from M4
(`alpha-a17-email-invites`): two rounds of the picky review (A17-P, then A17-R2) and two of the
security review (A17-S, then A17-S2). Each line gives the finding's ID, its outcome and where the
fix lives. The owner checked the last fixes.

## Security review

| ID | Outcome | Where |
|---|---|---|
| A17-S-1 | Fixed. The inviter's own invite-email caps count every typed address alike, so the allowance an address uses says nothing about it; the shared caps count only an address that may be mailed and passed the inviter's caps. Cross-address test for a new and an older inviter. | `packages/server/src/games/invite-mail.ts`, `apps/node/src/invites.test.ts`, 06 §6.6, 08 T4 |
| A17-S-2 | Accepted risk F-20, with the instance cap now stopping invite emails for the rest of the day once crossed. | `docs/security/findings.md`, 08 §4, 06 §6.6 |
| A17-S-3 | Fixed. A new account's lower rate lifts only once it has a past opponent. | `packages/server/src/db/auth-repos.ts`, 06 §6.6 |
| A17-S-4 | Fixed. A display name with seven or more digits anywhere, of any form, is refused when set. | `packages/server/src/accounts/display-name.ts`, 06 §5.1, 04 |
| A17-S-5 | Fixed. The claim at onboarding is capped per runtime and the sweep claims the rest; 09 §3 counts the statements of a create and an onboarding. | `packages/server/src/games/claim.ts`, `apps/worker/src/runtime.ts`, 03 §8, 06 §6.4, 09 §3, 10 |
| A17-S-6 | Recorded: the Worker's lobby-expiry backlog is a residual until the first Workers deployment (F-16). | 09 §3, 10, `docs/security/findings.md` |
| A17-S-7 | Fixed. The timing suite times a create with each kind of typed address. | `apps/node/src/auth-timing.test.ts`, ADR 0006 |
| A17-S-8 | Fixed. 02 §4 and 08 T20 agree with 06 §6.4: a claim takes no inbound-cap count. | 02 §4, 08 T20 |
| A17-S-9 | Fixed. `sent_at` is written after the sender accepted the email. | `packages/server/src/games/invite-mail.ts`, 04 |
| A17-S-10 | Fixed. A three-seat secrecy case. | `apps/node/src/games-secrecy.test.ts` |
| A17-S2-1 | Fixed. F-20 says what the remaining probe reveals and how the day's stop bounds it. | `docs/security/findings.md`, 08 §4 |
| A17-S2-2 | Noted for the first arm64 timing job (ADR 0006). | — |
| A17-S2-3 | Fixed. The alert and the day's stop are written before any send, at the request's time. | `packages/server/src/games/invite-mail.ts` |
| A17-S2-4 | Fixed with A17-S-4 (digits counted after NFKC folding). | as above |
| A17-S2-5 | Recorded in F-20. | `docs/security/findings.md` |

## Picky review

| ID | Outcome | Where |
|---|---|---|
| A17-P-1 | Fixed. A hidden invitation is never mailed. | `packages/server/src/games/invite-mail.ts`, 06 §6.3, tests |
| A17-P-2 | Fixed with A17-S-1. | as above |
| A17-P-3, A17-P-4 | Fixed with A17-S-5. | as above |
| A17-P-5 | Fixed with A17-S-8. | as above |
| A17-P-6 | Fixed. Tests for the claim's retry, the onboarding cap, the sweep's per-run limits and the cap stops. | `packages/server/src/games/claim.test.ts`, `apps/node/src/invites.test.ts`, sweep tests |
| A17-P-7 | Fixed. The instance cap alerts once per window. | `packages/server/src/games/invite-mail.ts` |
| A17-P-8 | Fixed with A17-S-9. | as above |
| A17-P-9 | Fixed with A17-S-3. | as above |
| A17-P-10 – P-13 | Fixed. Roadmap and comment corrections; the email leaves out the per-move limit until turn timeouts exist; the counter residual is written down. | 10, 03 §8, 06 §6.3, §6.6, `packages/server/src/games/expiry.ts` |
| A17-R2-1 | Fixed. Unused exports removed. | `packages/server/src/games/invite-mail.ts`, `db/repositories.ts` |
| A17-R2-2 | Fixed with A17-S-6. | as above |
| A17-R2-3 | Fixed. The creation timing tests have their own measured limit. | `apps/node/src/auth-timing.test.ts` |
| A17-R2-4 | Noted for the first arm64 timing job. | — |
| A17-R2-5 | Fixed with A17-S-4. | as above |
| A17-R2-6 – R2-9 | Fixed. A comment; the onboarding claim count is required of each runtime, with tests; invite ids are paired once; a partly failed send. | `packages/server/src/auth/limits.ts`, `app.ts`, `apps/worker/src/runtime.ts`, tests |
