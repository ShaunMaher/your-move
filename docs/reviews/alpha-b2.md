# Alpha B2 review (issue #18, instance-wide email caps): resolutions

This record covers the review of `alpha-b2-email-caps`: the instance-wide email caps sized on
their 24-hour worst case, with a startup check against the sender's daily quota (spec v0.9.33).
The slice had two rounds of the picky review (B2-P, B2-P2) and of the security review (B2-S,
B2-S2); the owner read the last fixes and signed off.

| ID | Outcome | Where |
|---|---|---|
| B2-P-1, B2-S-1 | Fixed. The account-deleted confirmation counts toward the OTP email caps after the deletion and is skipped over them; 08 §4.2 states how each kind of email is counted. | `packages/server/src/auth/routes.ts`, `otp.ts`, 06 §7, 08 §4, §4.2 |
| B2-P-2 | Fixed. A 500-a-day trial needs the caps lowered too, with example figures. | `.env.example`, `docs/deploy.md` |
| B2-P-3 | Fixed. A claimed nudge over the cap is reported as capped, not failed, and is due again after the nudge interval. | `packages/server/src/sweep/nudges.ts`, 03 §7 |
| B2-P-4 | Fixed. The startup error names each cap's value, W and where the quota came from. | `packages/server/src/config/parse.ts` |
| B2-P-5 | Fixed. 501 sign-in requests through the real path give exactly 500 sends and identical answers. | `apps/node/src/auth-parity.test.ts` |
| B2-P-6, B2-P2-3 | Fixed. Reflowed. | 03 §7, `docs/deploy.md` |
| B2-S-2 | Fixed. The tunnel compose file passes the quota and the three caps through; empty means unset. | `apps/node/docker-compose.tunnel.yml`, `tunnel.env.example` |
| B2-S-3 | Fixed. 08 §4.2 cites F-12 and states the cost of holding the sign-in cap; F-12 updated. A per-IP daily request limit is deferred. | 08 §4.2, `docs/security/findings.md` |
| B2-S-4 | Fixed. SMTP through Google's relay shares the Workspace quota: set `EMAIL_DAILY_QUOTA`. | `docs/deploy.md`, 09 §1, 08 §4.2 |
| B2-P2-1, B2-S2-1 | Fixed in wording. The source scan is a tripwire for the usual shapes and review covers the rest; a type-enforced check is deferred. | 08 §4.2, `apps/node/src/email-budget.test.ts` |
| B2-P2-2 | No change. A claimed nudge over the cap shows only as capped, as designed. | — |
| B2-S2-2 | Fixed. A failure to count the confirmation is logged by class and the deletion still answers 204. | `packages/server/src/auth/routes.ts` |
