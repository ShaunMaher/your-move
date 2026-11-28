# Alpha A20 review (invitation notices): resolutions

This record covers the review of `alpha-a20-invite-notices`: the generic invitation push and the
invitation email to users with email nudges on, pulled forward from M4, with F-17's fix (spec
v0.9.38). It had two rounds of the picky review (A20-P, A20-P2) and of the security review
(A20-S, A20-S2); the owner read the last fixes and signed off. The owner kept the coder's
decision that every invite-email cap applies to the invitation email (A20-P-2 against A20-S-3).

| ID | Outcome | Where |
|---|---|---|
| A20-S-1 | Fixed. F-17: the inbound cap counts live invitations (`invites` rows whose seat is still live), with the same read for every address; F-17 marked fixed. | `packages/server/src/db/invite-repos.ts`, `games/invite-mail.ts`, `games/create.ts`, 06 §6.7, 04 |
| A20-S-2, A20-P-1, A20-P2-1 | Fixed. The background task runs in order (the cap's alert and day stop, the emails, `sent_at`, then the push); 09 §3 states the Worker statement counts, and 10 notes the push needs its own invocation on the Free plan. | `packages/server/src/games/routes.ts`, 09 §3, 10 |
| A20-S-3, A20-P-2 | Kept (owner decision); accepted residual F-24: strangers can use up a nudged user's per-address email cap, while the push still arrives. | `docs/security/findings.md`, 06 §6.2 |
| A20-S-4 | Fixed. F-19 covers the invitation push and email from an AI-assistance pick or a rematch. | `docs/security/findings.md` |
| A20-S-5, A20-P-7 | Documented. The daily push counter is taken before delivery, on purpose. | `packages/server/src/push/notify.ts`, 03 §7 |
| A20-S-6 | Documented. The Node background shares the event loop. | 06 §6.6, 03 §7 |
| A20-P-3 | Fixed. Turning email nudges on lifts the holder's own `unsubscribed` row, never `bounced` or `complained`. | `packages/server/src/db/auth-repos.ts`, 03, 04, 06 |
| A20-P-4 | Fixed. A rematch whose pick becomes an invitation is tested. | `apps/node/src/invitation-notices.test.ts` |
| A20-P-5 | Fixed. The Settings copy no longer promises an email for every invitation. | `apps/web/src/screens/Settings.tsx` |
| A20-P-6 | Documented. The onboarding claim's push is normally a no-op. | 06 §6.4, 09 §3 |
| A20-P-8, A20-P2-3 | Fixed. Wrapping, and one shared background-failure helper. | `packages/server/src/http/background.ts`, 06 |
| A20-S2-1, A20-P2-2 | Fixed in wording: racing creations can get up to the pair limit of `normal` invitations; serialising the check is an M4 item. | 06 §6.7, F-17, 10 |
| A20-S2-2 | Recorded for M4: what happens to a lifted `unsubscribed` row when the account is deleted. | 10 §M4 |
