# Alpha A21 review (child safety before the path game): resolutions

This record covers the review of `alpha-a21-child-safety`: the age confirmation and its re-prompt,
the gated endpoints, the under-age exit, the privacy page and the copy review (spec v0.9.41). It
had two rounds of the picky review (A21-P, A21-P2) and of the security review (A21-S, A21-S2);
the owner read the onboarding write, the guarded deletion and the gates, and signed off. Owner
decisions: turning email nudges on waits for onboarding (S-1), join-link create and rotate are
gated (S-5), the Turnstile sentence waits for enforcement (P-6), and S-6 is accepted as F-25.

| ID | Outcome | Where |
|---|---|---|
| A21-S-1 | Fixed (owner decision). `emailNudges: true` answers `403 ONBOARDING_REQUIRED` until the request leaves onboarding done. | `packages/server/src/auth/routes.ts`, 05, 06 §5 |
| A21-S-2 | Fixed. Completion is judged on the stored row in one batch; a gone account answers `401`. | `packages/server/src/db/auth-repos.ts`, `routes.ts`, 06 §5 |
| A21-S-3 | Fixed. `WRITES_USER_MINUTE` covers `PATCH /api/v1/me` and the under-age exit. | `routes.ts`, 05, 08 §4 |
| A21-S-4, A21-P-5, A21-P-15 | Fixed. The privacy page names the suppression record, every email sent and the typed address of a pending invitation; 08 §5 lists `email_suppressions`. | `apps/web/src/screens/Privacy.tsx`, 08 §5 |
| A21-S-5 | Fixed (owner decision). Join-link create and rotate are gated; revoke, start, cancel and moves stay open. | `packages/server/src/games/join-routes.ts`, 05, 06 §5 |
| A21-S-6 | Accepted: F-25. | `docs/security/findings.md` |
| A21-S2-1 | Accepted, recorded in 06 §5: a name-only request in flight when onboarding completes isn't counted as a rename, at most once per account. | 06 §5 |
| A21-S2-2, A21-P2-1 | Fixed. `saveOnboarding` in the repository contract, on both adapters. | `packages/server/src/db/auth-contract.ts` |
| A21-P-1 | Fixed. Privacy's Back keeps the remembered return path. | `apps/web/src/App.tsx` |
| A21-P-2, A21-P-3 | Fixed. The API descriptions and 04's `age_attested_at` note. | `packages/shared/src/auth.ts`, 04 |
| A21-P-4 | Fixed. A route test for the exit losing to onboarding. | `apps/node/src/onboarding.test.ts` |
| A21-P-6 | Fixed (owner decision). No Turnstile sentence until enforcement ships. | `Privacy.tsx`, 07, 08 §5 |
| A21-P-7, A21-P-8, A21-P-11 | Fixed. The control at fault is marked and focused; the Privacy link only on the email step; the age statement always shown. | `apps/web/src/screens/Welcome.tsx`, `SignIn.tsx` |
| A21-P-9, A21-P2-6 | Fixed with comments. | `packages/server/src/accounts/onboarding.ts`, `db/repositories.ts` |
| A21-P-10 | Fixed. One short-deletion builder; the batch result is typed. | `auth-repos.ts`, `db/database.ts` |
| A21-P-12, A21-P-13, A21-P-14 | Fixed. | `tests/e2e/src/onboarding.spec.ts`, `onboarding.test.ts`, `config/parse.ts` |
| A21-P-16 | Recorded: a `displayName`-only request no longer completes onboarding (as 05 always said), and existing users are asked for the age confirmation once. | commit `e47ad67` |
| A21-P2-2 to A21-P2-5 | Fixed. | 05, 08 §4, 09 §1, 10 |

After sign-off, the MR pipeline found one load-dependent test: the re-prompt's arrival focus asserted synchronously after `findByRole`, which 11 §4 forbids. The owner fixed it with `waitFor` (`apps/web/src/App.test.tsx`, commit `130abb4`).
