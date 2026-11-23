# Security findings and accepted risks

Tracks security findings and knowingly accepted risks (08 §7). Ids are `F-<n>`; status is
`open`, `fixed` or `accepted-risk`. Every OSV ignore in `osv-scanner.toml` names an entry here
with the same expiry (11 §6).

| Id | Status | Source | Risk | Rationale and mitigations | Review by |
|---|---|---|---|---|---|
| F-1 | accepted-risk | 06 §3 | Per-email OTP verify lockout (temporary denial of service) | Bounds guessing; temporary; logged | M2 |
| F-2 | accepted-risk | 08 T20 | Past-opponent relationships spread through N-player auto-joins | Both-acted rule; `whoCanAddMe = nobody`; games with AI seats always invite | M4 |
| F-3 | accepted-risk | 08 T4 | Q3 residuals: signing up, then accepting or declining, reveals that an address has an account | Needs the address holder's own action | M4 |
| F-4 | accepted-risk | 08 §5, 09 §2 | Gmail *Sent*-folder copies of every email sent | Dedicated sender user, 2-Step Verification, IMAP/POP off, periodic purge (Trash keeps 30 days), disclosed on the privacy page; move to a transactional provider before the instance grows | Before growth |
| F-5 | accepted-risk | 08 T27 | Installed game packages are fully trusted: a malicious one can compromise the instance and players' accounts | Install only trusted authors; review diffs; built-output rules and globals allow-list; test kit incl. isolation; Node code generation off and secrets scrubbed before loading games; CSP; no automerge; SES/isolates later | First third-party game |
| F-6 | accepted-risk | 08 T30 | Config controls who is admin; admins who also play on their admin account | Exclusive admin tokens of ≤ 30 days, audited, every admin notified on creation; docs say not to play on admin accounts | M3 |
| F-7 | accepted-risk | 08 T31 | AI assistance can be detected and labelled, not prevented | Default off; `via` marking; AI seats labelled with their owner; rules page | M8 |
| F-8 | accepted-risk | 08 §6 | Shared, unprotected CI runners: MR and `main` jobs share hosts | Unprivileged jobs, rootless image builds; secrets only in variables that are both protected (protected `main` and `v*` tags) and environment-scoped (`release`, `renovate`, `production`) — our GitLab CE has no protected environments; protecting runners is an owner-side change | M0 |
| F-9 | accepted-risk | 08 §6 | Images and packages are not signed yet | Publishing only from `main`/tags in the `release` environment with a deploy token held in a protected, environment-scoped variable; protected packages and container tags (M1 verifies they exist on CE; fallback: a Maintainer project access token in the same variable, with protected variables and refs as the only confinement); deploy by digest | Before third-party deploys |
