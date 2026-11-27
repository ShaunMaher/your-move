# 08 — Security

Small hobby-scale service, but it holds email addresses, sends email on users' behalf, and is open
source (attackers can read the code). Design so that reading the code doesn't help.

## 1. Assets

1. Users' email addresses (PII) and the social graph (who plays whom).
2. Account access (sessions).
3. Our email-sending reputation / domain (abuse → blocklisting → OTPs stop arriving → nobody can
   sign in).
4. Game integrity (hidden hands, bag/deck order, secret actions; fair turn enforcement).
5. Operator secrets (`APP_SECRET`, VAPID private key, email provider credentials — including, for
   the Gmail provider, an OAuth refresh token that can send mail as the dedicated sender user —
   Cloudflare API token, Cloudflare Tunnel token).
6. Licensed and uploaded word lists (`serverOnly` dictionaries) and their rights attestations.
7. **Minors' safety and privacy**: children may play through a parent's account (Q20); a game is
   aimed at groups of kids. No stranger should be able to contact them (T20, T24).
8. **API tokens** (06 §8): each one acts as its account, within its scopes.
9. **The admin capability** (05 §Admin API): suspend, delete and cancel across the instance.
10. **The build**: installed game packages and the published `@your-move/*` packages that other
    instances and game authors depend on.

## 2. Threats and required controls

| # | Threat | Controls (MUST unless stated) |
|---|---|---|
| T1 | OTP brute force | 8-digit codes, 5 attempts/challenge, atomic attempt counting (06 §3.1), per-email and per-IP-prefix limits, global circuit breaker, constant-time compare, codes HMAC-hashed at rest |
| T2 | Email bombing a victim / OTP spray across many addresses | per-email request limits with silent drop (no challenge created); per-IP-prefix limits; **instance-wide OTP email cap** (§4); optional Turnstile, auto-enabled by the circuit breaker |
| T3 | Spam via invite emails (using us as a relay), incl. Sybil accounts | sign-in required; fixed template; display-name restrictions (06 §5); per-inviter, new-account, per-target and **instance-wide** invite caps; suppression list + one-click unsubscribe; inviter identity shown in email |
| T4 | Account enumeration | `/otp/request` identical response *and* timing parity (06 §3.2); `/otp/verify` errors indistinguishable with dummy HMAC; adding players by email gives the same response, work and timing whether or not the address has an account, is un-onboarded, suppressed, over a cap or blocked (06 §6.1, Q3), with the invite email built for every typed address, the inviter's invite-email caps counting every typed address as an attempt whatever it resolves to, the shared caps (per address, instance-wide) counting under their real keys only an address that may be mailed and passed the inviter's caps (every other one adds to the never-read `silent` counter), one background task scheduled, and the email sent only after the response (06 §6.3, §6.6, alpha A17 and its review S-1); invited users' names are hidden until they accept; adding by email never auto-joins; rows never `joined` show no name or id to anyone in any state (declined and removed included, 05 §Common types); per-pair limits keyed by the typed address's `emailId`; only literal duplicate invitees are rejected; invite claims are invisible to other members (02 §4); a rematch answers a non-player exactly as reading the game does (`404`) and picks only people its caller already played with, through the creation path's own checks (06 §6.11). Residual (accepted): signals that need a real person to act — someone **signs up** with the address and then **accepts** or **declines** the invitation (06 §6, privacy note) |
| T5 | Session theft / lingering access | `__Host-` cookie, `HttpOnly`, `Secure`, `SameSite=Lax`; tokens hashed at rest; sessions list + revoke; logout-all; revocation also kills push subscriptions and live sockets (06 §4); step-up OTP for account deletion, API-token creation and admin actions (06 §7) |
| T6 | CSRF | `SameSite=Lax` + strict `Origin` check on every cookie-authenticated state-changing request and the WebSocket upgrade (bearer-token requests are exempt — browsers never attach them — and a request may not carry both, 05 §Conventions); JSON-only bodies (05 conventions). Exemptions are listed explicitly: the unsubscribe route `/api/v1/email/unsubscribe` (Origin and JSON) and the dictionary upload route (JSON only). No state change on GET — including timeouts (sweep only) and unsubscribe (GET shows a page). |
| T7 | XSS / HTML injection | React escaping only; **no `dangerouslySetInnerHTML`** (lint rule); strict CSP (§3); display names treated as untrusted everywhere, including email HTML templates (escaped) and push payloads (plain text) |
| T8 | Cheating: reading hidden information (other hands, bag/deck order, secret actions) | Game data leaves the server only via module `view()`, the viewer's own `final_views` entry, public `record`s and `describe` text (04 invariant 4); generic perturbation test for every module covering views, summaries, `toAct`, `seatStatus`, error codes and details (including for illegal actions) and records (02 §6); `state`, `rng` and raw actions never serialised; `500`s carry no detail and logs never contain inputs, state or validator "received" values (09 §5); WebSocket carries only invalidations, to members only |
| T9 | Cheating: illegal moves, acting out of turn, replaying requests | Framework enforces membership (04 §Membership, so rows from before seat renumbering never grant access), `toAct` and `expectedVersion` + `write_token` transitions (03 §5.2); module schema + `validate` re-check every action server-side; client previews are never trusted |
| T10 | Predictable shuffles | WebCrypto-backed `RandomSource` + unbiased Fisher–Yates; seeded sources exist only in tests |
| T11 | IDOR | **Every user-owned row** (games via membership, sessions, push subscriptions, blocks, settings, uploaded dictionaries, join links via the game's creator) is queried scoped by the session's `user_id`. Using a resource in a new game is authorised by `ResourceProvider.authorizeForNewGame` (02 §2.1): someone else's or a deleted upload looks exactly like an unknown id. Blocks can only target past opponents or users who hold or held a row in a game with the blocker. `remove-seat` accepts only a row of the same game, never the creator's own. Non-owned resources return `404`. Tests use foreign, deleted and nonexistent ids. |
| T12 | Push endpoint SSRF / abuse | Parse with `URL`; require `https:`, no userinfo, no explicit port other than 443, hostname not an IP literal; host must equal or be a label-boundary suffix of an allow-listed push service (`push.apple.com`, `fcm.googleapis.com`, `notify.windows.com`, `push.services.mozilla.com`) — e.g. `x.push.apple.com` ✓, `evilpush.apple.com` ✗, `push.apple.com.evil.tld` ✗. The parser's lower-cased, punycoded host is what is compared, a trailing dot or a fragment is refused, the endpoint is at most 2,048 characters, the parsed URL is what is stored and posted to, and the check runs again before every send. Outbound fetch with `redirect: "manual"` (a redirect counts as a failure) and a 5 s timeout. Keys validated (P-256 point, 16-byte auth, unpadded base64url). ≤ 10 subscriptions/user. |
| T13 | DoS / resource abuse | Body size limit (16 kB), placements ≤ rackSize, rate limits on all write endpoints, game count caps (counted against the creator only), WebSocket per-user cap, per-IP upgrade limit, 1 KiB WS message cap, Cloudflare's edge protection on CF target |
| T14 | Email header injection | Recipient addresses validated by schema; subject/body from templates; provider HTTP APIs (structured JSON); SMTP via a library. The Gmail provider sends raw MIME, so it goes through **one MIME builder** that RFC 2047-encodes every non-ASCII header value and rejects CR/LF in every header value (display names, subjects, addresses); unit tests use hostile display names (CR/LF, `Bcc:` injection, very long and non-ASCII names) |
| T15 | Secret leakage | Secrets only from env/secret bindings, and on Docker preferably from files via `*_FILE` variables backed by Docker secrets (so `docker inspect` doesn't show them, 09 §1); the Gmail provider uses **no domain-wide delegation**: an Internal OAuth client and a refresh token granted once by a dedicated sender user, scope `gmail.send` only, so a leaked refresh token lets an attacker send mail as that one user and nothing else (no reading mail, no other users); a leaked client secret of the Internal client additionally lets an attacker start OAuth consent flows targeting users within the Workspace, so it is treated as a secret of the same class; the authorize helper verifies the granting account and scope (09 §2); the sender user has 2-Step Verification on and IMAP and POP disabled; credentials revoked and re-issued if exposed (09 §2); `.dev.vars`/`.env` git-ignored; logs never contain OTPs, tokens, cookies, request bodies, raw or masked emails (only the HMAC `emailId`); the `Authorization` header is redacted in app logs and must be excluded from edge logs (Caddy log config, Workers Logs/Logpush field selection — verify on Workers, 09 §5); on Node, secrets are scrubbed from `process.env` before game packages load (02 §7.5) |
| T16 | Supply chain | See §6 |
| T17 | Unsubscribe-link forgery | HMAC-signed, purpose-bound tokens (05 §Email links); GET shows a page, POST changes state |
| T18 | Privacy leakage via lock-screen notifications | Push text is built only from module `describe` text of public records and display names (02 §5) — never emails or hidden state. In the lobby, only the person being added gets a push: an auto-join by a past opponent ("<creator> added you to a game", or "<creator> wants a rematch." for a rematch) or a new invitation, whose push names nobody ("You have a new game invitation", ≤ 1 per recipient per day, never for `hidden` or `inert` invitations); with email nudges on, an invitation also sends one fixed-template email naming the inviter (06 §6.2), and a seat that has waited a day gets the "It's your turn" email, built like a push from the game type's name, display names and public `describe` text, never state, options, totals or standings (03 §7). No pushes or emails for joins by others, accepts, declines, leaves, removals or lobby endings (`cancelled`, `expired`, `declined` from the lobby, including account-deletion cancels); "game ended" notifications only for games that reached `active` (02 §4, 03 §7) |
| T19 | Dev-only features in production | All dev behaviour (`console` email, `/__dev/*`, non-`__Host-` cookie) gated by the single `isLocalDev(config)` predicate (06 §4), which requires the parsed `PUBLIC_URL` host to be exactly `localhost`/`127.0.0.1`/`[::1]` over `http`. CI test: production build returns 404 for `/__dev/emails`. |
| T20 | Harassment and unsolicited contact (incl. of minors) | `whoCanAddMe` (default: only past opponents picked from the list auto-join; adding by email is always an invitation whose push names nobody, 06 §6.2); past-opponent pairs form only at game end between players who both acted, and link joiners only with the creator's explicit confirmation (06 §6.9); a blocked pair is never written as past opponents and `add-player` is a silent no-op for one (`canAddPlayers` still lists them, so the prompt reveals no block); a block between the creator and a picked `userId` invitee fails as "not a past opponent", while blocks between invitees or with members give silent `inert` seats (04 invariant 6, 06 §6.1); invite claims apply the full block rule against every row and keep the `delivery` the inbound cap gave the seat at creation, counting nothing again (06 §6.4); inbound invitation cap per creator (1/day) and in total (3/day), over-cap invitations go to a collapsed *Hidden invitations* list (06 §6.7); outbound cap on email invitees; blocks checked between **every** pair of users in a game when seats are added, on accept, on join and at start, and blocking a lobby co-member takes effect at once (06 §6.10); names and ids of rows never joined hidden from everyone; creator can remove seats in the lobby; per-pair game-creation limits; a decline or timeout before a first action is never a loss; active-game caps count only the creator's own games; display-name rules (06 §5.1) and a rename limit (3 per 30 days, logged); un-onboarded accounts are invisible to others. Residual (accepted): a past opponent can auto-join a user into an N-player game alongside third parties the user has never met, who then become past opponents if everyone acts; `whoCanAddMe = nobody` avoids it. Open for M4, before blocks can be made (Q29): a creator who picks two past opponents with a block between them sees the later one invited rather than joined (06 §6.1); likewise a rematch (06 §6.11) seats the later of two carried-over players with a block between them as an `inert` invitation, which the finished game shows them as "invited" and whose accept is `404`, so that player learns of a block involving them. Accepted for the alpha (F-19): a past opponent can add you and push to you before the `whoCanAddMe` choice and Block exist; a rematch (06 §6.11) is the same pick and adds no way around either |
| T21 | Dictionary upload abuse (resource exhaustion, zip bombs, using us as file storage, offensive names) | Streamed upload with compressed + decompressed size caps, word-count cap, strict charset/sorted validation (so arbitrary files are rejected), per-user quota counting every not-yet-purged blob, daily limits, instance-wide byte and daily caps with alert, account maturity (7 days or a finished game), temporary-key upload with orphan sweep, server-generated UUID keys (filesystem adapter rejects keys not matching `^[a-z0-9-]{1,64}$` and checks the resolved path stays under `BLOB_DIR`), separate Docker volume for blobs recommended, name validated like display names, Origin check |
| T22 | Leaking `serverOnly` word lists (licensing exposure for the operator) | No route serves list contents, blob keys or hashes (tested on every route); `distribution` checked server-side; the service worker never caches them, and the shell hands a board only a list marked `public` (02 §3); the preview endpoint takes only a full module action and runs every rack/structural check before any lookup (words §10.3); `serverOnly` lookups are limited **per word looked up** per user and per game (§4); only the uploader can use an upload in new games (T11); logs never contain dictionary contents. Accepted residual: a determined opponent can still probe words from their own racks, slowly |
| T23 | Copyright complaints about uploads | Uploads are private to the uploader's games; rights attestation stored; takedown contact on the help/privacy page; an admin can list uploads' metadata and delete **any** upload (`DELETE /api/v1/admin/dictionaries/:id`, or `pnpm admin:dict:delete <id>`, 05 §Admin API) |
| T24 | Join-link abuse (guessing, leaked or forwarded links, joining someone's game uninvited) | 128-bit tokens stored hashed; token in the URL fragment so it never reaches logs; URL shown only on create/rotate; expire at start / revoke / rotate / lobby expiry / 7 days; sign-in and an explicit Join tap required (no auto-join after sign-in; return path kept in `sessionStorage`, same-origin `/join` only); block checks against every member; people who declined, left or were removed (while that link was live) can't come back through it; lookup/join rate-limited per user and IP; indistinguishable `404`s; a game with a live link or any link joiner never auto-starts, so the creator always sees who joined and can remove them before Start; link joiners become past opponents only of the creator and only if the creator confirms; the join page removes the token from the address bar and history; the share UI warns that anyone with the link can join |
| T25 | Malicious/buggy game module crashing or slowing the server | Modules are reviewed code (first-party, or third-party installed deliberately, T27); module exceptions → `500` without partial writes (transition aborts); per-call CPU budget (≤ 5 ms p99 on reference hardware) checked by the test kit on each module's `worstCase` inputs (02 §6), measured on the host that runs the kit (a developer machine, the build, CI); `pnpm games:verify --cpu-budget-ms <n>` (or `KIT_CPU_BUDGET_MS`) sets it (raised only for a host slower than the reference hardware), and the build log records it. CI uses a calibrated budget everywhere: one variable, `KIT_CPU_BUDGET_MS` (20 ms, 4× the reference; as text a whole number from 1 to 50), which every kit run reads when it isn't given a budget, so `pnpm build`, the test job's full kit and the packages' own kit tests, and the image build through a build argument, because the shared amd64 runner is a `qemu64` VM 2–3× slower than a developer laptop and often loaded (docs/deploy.md, "CI runners"); in CI, installed third-party games are therefore checked at the calibrated budget too; the real 5 ms budget is enforced on developer machines, by every local `pnpm test` and `pnpm games:verify`; `serverOnly` dictionary loads limited per user (§4) |
| T26 | Forced forfeits through game settings | The turn timeout is a framework setting, an integer 1–30 days, validated before the module sees options, and shown on every invitation and in the lobby (02 §4). A player who never acted takes no loss: declining or timing out before a first action either ends the game `declined` with no ranking (if too few would remain) or puts the seat out as `declined`, excluded from the ranking (02 §4) |
| T27 | A malicious or compromised **third-party game package** (02 §7) | **Installing a game is full trust: a malicious one can compromise the whole instance and the account of everyone who plays on it.** Its engine shares the server process (it can patch shared built-ins such as `JSON.parse` to read other requests, other games' state and `serverOnly` lists, and leak them through its own `view`); its client runs on the app origin with players' sessions, so same-origin `fetch` passes the Origin check and it can act as the player (change settings, create games, phish a step-up code). There is no runtime sandbox in v1 (02 §7.5). Controls that make honest packages verifiable and raise the bar for dishonest ones: packages are installed only by the operator, named in `instance.config.ts`, kept in `dependencies` and pinned by the lockfile, from an explicitly named registry; `pnpm games:verify` checks the **built output** with the import rules and an ESLint globals allow-list and no-built-in-writes rule (no `fetch`, `crypto`, timers, `Date.now()`, `Math.random`, `eval`/`Function`, `process`, `globalThis` access), runs the test kit (incl. cross-game isolation), checks the manifest, icon sanitisation and licence; Node runs with `--disallow-code-generation-from-strings` and scrubs secrets from `process.env` before loading the game registry (Workers forbid code generation already); client assets are bundled at build time and the CSP forbids remote code (§3); Renovate never auto-merges anything (11 §8); operators are told to install only games from authors they trust, to review every upgrade, and that **admins shouldn't play on their admin account** (09 §1.3). Residual (accepted, `docs/security/findings.md`): a package that passes these checks but hides malicious code in allowed constructs; SES `lockdown()` and isolate sandboxes are later hardening |
| T28 | **Prompt injection** against users' AI agents through game content | The whole view, history records, `describe` text, display names and game names reach agents through `@your-move/mcp` wrapped as untrusted data between explicit delimiters, with tool descriptions warning the agent not to follow instructions inside it (02 §9.4). Scope limits bound the damage, not the MCP tool list: an agent with shell or file access can read its token and call any endpoint the token allows. So tokens are narrowly scoped (`play` = only seats already held; creating games and joining are separate opt-in scopes, and tokens can never add email invitees, 06 §8), the MCP server refuses tokens with more than `read` + `play` by default and always refuses `admin` tokens, and the token lives in a 0600 file or keychain, not the agent's config. With the recommended `read` + `play` token an injected instruction can at worst play, resign or decline the token's own seats. Display-name rules (06 §5.1) still apply |
| T29 | **API token** theft or misuse, and **dependency confusion** on the `@your-move` scope | Tokens are opt-in, scoped (`read` / `play` / `games:create` / `join`, or an exclusive `admin`), expire within a year (30 days for `admin`), are shown once and stored as HMACs (`token/v1`, 06 §8); accepted only in the `Authorization` header (never query strings or WebSockets), never logged; creating one needs an onboarded session **and** a fresh step-up code of the `token_create` purpose, and emails the account; logout-all can revoke all tokens; a token can't mint tokens, change settings, manage sessions or delete the account; `ym_pat_` prefix so leaked tokens are caught by secret scanning (gitleaks in CI and pre-commit, 11 §6); per-token rate limits (§4); revocable at once; suspension and deletion revoke them; cookie + bearer on one request is rejected, and bearer requests can't be forged cross-site, so they're Origin-exempt; no CORS in v1 (05). The `@your-move` npm scope is claimed by the project's npm organisation (Q25), so no one else can publish under it; releases live on the GitLab registry, so every install instruction and the MCP docs name that registry explicitly (02 §7.4) |
| T30 | **Admin API** abuse (stolen admin session or token, malicious operator tooling, a malicious game acting as an admin) | Admins come only from `ADMIN_EMAILS` config; admin access is **by admin token only** — no cookie-based admin access in v1, so a script on the app origin (T27) can't use an admin's session for admin actions; an admin token is exclusive (no other scope), lives ≤ 30 days, needs a `token_admin` step-up code whose email names the action, notifies **every** admin when created and is audited; the CLI reads it from `ADMIN_TOKEN_FILE` (preferred) or `ADMIN_TOKEN`; `api-client` and the MCP server refuse admin tokens by default; non-admins get `404` on every admin route (logged and rate-limited, not audited); separate, low rate limits (§4); append-only `admin_audit` for every admin-principal request with a stable `actor_key` that survives the admin's own deletion (04); admins can't see hidden game state or browse email addresses (lookup by exact address only); the admin's `reason` is never shown to players; admin routes are excluded from the public OpenAPI document. Residuals (accepted): whoever controls the deployment's config controls the admin list — operators are trusted by definition; an admin who plays games on their admin account exposes it to installed games (T27), so the docs say not to |
| T31 | **AI players passing as people, undisclosed AI help, and owner collusion through AI seats** | AI accounts always show as "<owner>'s AI <name>" with a badge in every place a name appears, can be seated only by their owner when the owner creates a game, and are visible before anyone accepts (02 §9.2); the API carries `kind`, `aiOwnerName`, `aiAssistance` and history `via` so every client can show them (05); games with AI seats (other than the owner alone with their own AI) or with AI assistance allowed never auto-start and turn past-opponent auto-joins into invitations, so every human accepts knowingly (02 §4); `aiAssistance` defaults to `off` whenever a seat is open or two or more people play, is fixed at creation and shown on invitations and the join page, so token play on a human seat needs everyone's knowing consent (`403 AI_NOT_ALLOWED`, 02 §9.3); in game types with hidden information an owner's AI seats can't share a game with other humans, because the owner can read the agent's hand (02 §4). Residual (accepted, stated on the rules page): a player can script their own browser session or copy suggestions by hand |

## 3. HTTP security headers

Applied to every response — by Hono middleware for server-handled paths and, on Cloudflare, by the
generated `_headers` file for static assets (03 §9). One shared definition generates both.

- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none';
  base-uri 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'self'; manifest-src 'self'`
  (`connect-src 'self'` covers same-origin `wss:` in current browsers; add the explicit `wss://`
  origin if testing shows otherwise.) When Turnstile is enabled: add
  `https://challenges.cloudflare.com` to `script-src` and `frame-src`. No `unsafe-inline` or
  `unsafe-eval` in production (07 §4 build settings): the web app runs Zod `jitless` (no compiled
  parsers, which use `new Function`) and must never need `unsafe-eval`.
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` when `PUBLIC_URL` is https.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=()`,
  `Cross-Origin-Opener-Policy: same-origin`.
- API responses: `Cache-Control: no-store`.

## 4. Rate limits (initial values, all configurable)

| Key | Limit | On exceed |
|---|---|---|
| OTP request per email | 5 / h, 10 / day | silent (no challenge, no email, `202`) |
| OTP request per IP (bucketed, §4.1) | 20 / h | `429` |
| OTP verify fails per email | 10 / h | `429` (temporary lockout) |
| OTP verify per IP | 50 / h | `429` |
| **OTP emails instance-wide** (sign-in codes or suspended notices, step-up codes, account-deleted confirmations; exactly as §4.2) | 200 / h, 500 / day (sized in §4.2) | silent; alert; auto-Turnstile if configured |
| **Failed verifies instance-wide** | 500 / h | alert; auto-Turnstile if configured |
| Email invitees per user (every typed address, whatever it turns out to be) | 10 / day, 5 / h | `429`, nothing created |
| Game creation per pair / per user (a pair is creator + `userId`, or creator + `emailId` for a typed address, 06 §6.7) | 5 / day / 30 / day | `429` |
| Invite emails per inviter (every typed address counts as an attempt, whatever it resolves to; only email-invite seats are mailed, 06 §6.6) | 5 / day, 20 / 30 days (2 / day for new accounts, 06 §6.6) | silent (seat created, no email) |
| Invite emails per target address (by email HMAC) | 3 / 30 days | silent (seat created, no email) |
| **Invite emails instance-wide** | 100 / day (sized in §4.2) | silent; alert once per UTC day; once crossed, no invite email is sent for the rest of that fixed UTC day, whatever the sliding estimate says later. Many new accounts can still drain it, and an instance held at it reveals whether a typed address is an email-invite seat that may be mailed — nearly noiselessly on a quiet instance, at most about once a day since the stop: accepted risk F-20; the per-IP-bucket invite-email limit planned for M4 raises the cost of reaching the cap but doesn't close the probe |
| New accounts per IP (bucketed) | 10 / day | silent on `/otp/request` for unknown emails from that bucket (a never-emailed challenge is still inserted, for verify parity, 06 §3.2). Judged and counted where a sign-in creates an account, against the verifying client's buckets (an unknown address verifying from a full bucket gets `INVALID_CODE`); `/otp/request` only reads it, on every path |
| WebSocket upgrades per IP | 30 / min | `429` |
| Moves per user | 120 / min | `429` |
| Preview per user | 300 / min | `429` |
| `serverOnly` dictionary lookups per user (counted per word looked up, in `validate` and `preview`; the worst case is reserved before the module runs, 03 §10) | 60 / min, 2,000 / day | `429` (also blocks moves in that game until the window passes) |
| `serverOnly` dictionary lookups per game | 5,000 / day | `429` |
| Distinct `serverOnly` dictionary loads caused per user | 6 / h | `429` |
| Invitations received from non-past-opponents, per target | 1 / day per creator, 3 / day total | silent (`delivery = hidden`, 06 §6.7) |
| Display-name changes after onboarding | 3 / 30 days | `429` |
| Dictionary uploads per user | 5 / day (quota: 3 lists / 24 MB not yet purged) | `429` / `409` |
| **Dictionary uploads instance-wide** | 50 / day, `LIMIT_DICT_TOTAL_BYTES` (default 2 GB) stored | `503`; alert |
| Join-link lookups and joins per user (the joiner's limits only, never the creator's) | 30 / h | `429` |
| Join-link lookups and joins per IP (bucketed) | 60 / h | `429` |
| Join-link creations per user | 20 / day | `429` |
| Any authenticated write per user | 300 / min | `429` |
| **"It's your turn" email nudges instance-wide** (alpha A6, `LIMIT_NUDGE_EMAILS_PER_DAY`) | 150 / day: at most the cap per UTC day, up to twice the cap in any 24 hours (a sliding window over fixed UTC days; sized in §4.2) | silent: the sweep stops and claims nothing more, the rest wait for a later run; only claimed nudges count, and a claimed nudge whose count goes over the cap (only when two runs overlap) isn't sent; alert once per UTC day (03 §7) |
| "It's your turn" email nudges per recipient (alpha A6, `LIMIT_NUDGE_EMAILS_PER_USER_PER_DAY`) | 10 / day: about the cap per UTC day, up to about twice the cap in any 24 hours | silent: that recipient's other due nudges wait unclaimed; only claimed nudges count (03 §7) |
| Requests per API token | 120 / min, 10,000 / day (the account's limits apply too) | `429` |
| Failed bearer authentications per IP (bucketed) | 30 / h | `429` |
| API token creations per user | 5 / day | `429` |
| Games created with AI seats, per owner | 20 / day | `429` |
| AI-account creations per owner | 2 / day (and each counts toward the owner's 3 / 30 days rename budget, 06 §5) | `429` |
| AI-account deletions per owner | 5 / day | `429` |
| Step-up code requests per user (all non-sign-in purposes together) | 5 / h, 10 / day | `429` |
| Admin requests per admin | 60 / min | `429` |
| Refused admin-route requests (non-admins, `404`) per user and per IP bucket | 20 / h | `429`; logged, not audited |

Instance-wide numbers are sized for a friends-and-family deployment; operators raise them in config,
the instance-wide email caps only within the outbound email budget (§4.2).

**Deliberate exception (T13): the unsubscribe POST** (`/api/v1/email/unsubscribe`, 05 §Email links)
is public and not rate-limited. A request without a valid token costs one HMAC verification and
writes nothing; a valid token can only be had from an email we sent to that address, and acting on
it again changes nothing (idempotent). A limit keyed by client IP would instead make a mail
provider's one-click requests, which come from its shared egress addresses, fail for everyone on
it, against RFC 8058's expectation that the POST simply works.
"Alert" = an `error`-level structured log with a stable `alert` field, so it can be wired to
whatever notification the operator uses.

### 4.1 Client IP and bucketing

- **Source of the client IP**: Cloudflare Workers → `CF-Connecting-IP`. Node → by `TRUST_PROXY`:
  `false` → the socket address; `xff` → the entry `TRUST_PROXY_HOPS` positions from the **right** of
  `X-Forwarded-For` (the leftmost entries are attacker-controlled; a header with fewer entries than
  hops gets `400`, below, never the socket address, which is the proxy's and would put every such
  request in one bucket); `cloudflare` (Cloudflare Tunnel) → `CF-Connecting-IP`.
- In `xff` and `cloudflare` modes the **socket peer must be in `TRUST_PROXY_PEERS`** (CIDR list,
  default the private ranges `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`, loopback,
  as a fallback only — the compose files pin the proxy's address on `front` and set `TRUST_PROXY_PEERS`
  to it alone (loopback is not trusted), never the whole subnet: the Docker host has an address there, 09 §4); a request from any other peer gets `400` on every route that uses the
  client IP (the next bullet), and startup logs a warning naming
  the mode, and another when the broad default is in use. This stops
  header spoofing if the app port is ever reachable some other way; the deployment must still keep
  the port unpublished (09 §4).
- The header is required only where a client IP is used (rate-limited and audited routes): there a
  missing or invalid `CF-Connecting-IP` (or `X-Forwarded-For` with too few entries) gets `400`.
  `/api/health` never needs it, so the container's own health check works.
- **Cloudflare Pseudo IPv4** must be off, or set to "Add header" — never "Overwrite", which puts
  Class E pseudo-addresses in `CF-Connecting-IP` and defeats IPv6 bucketing (09 §4).
- Node warning when `TRUST_PROXY=false` and all recent requests come from private/loopback
  addresses (likely a misconfigured proxy, which would put every user in one bucket).
- **Normalise** IPv4-mapped IPv6 (`::ffff:a.b.c.d`) to IPv4 *before* bucketing.
- **Buckets**: IPv4 → the /32. IPv6 → three layered keys, all checked: /64 at the listed limit,
  /56 at 4×, /48 at 10×.
- Keys store `HMAC(K_ip, bucket)`, never raw IPs.
- Unit tests cover mapped addresses, XFF parsing with spoofed left entries, `CF-Connecting-IP`
  handling (missing/invalid → `400` on an IP-using route), peers outside `TRUST_PROXY_PEERS`
  (→ `400`), `/api/health` without the header (→ `200`), and IPv6 layering.

### 4.2 Outbound email budget

Every email the server sends counts toward exactly one of three instance-wide day caps, before it
is sent, and is sent only if that cap (and, for the first group, the hourly one) has room:

- `OTP_EMAIL_GLOBAL_DAY` (*C*), with `OTP_EMAIL_GLOBAL_HOUR`: the sign-in code, or for a suspended
  account the suspended notice, of an `/otp/request` that may send (one that passed the per-email
  and new-accounts limits; the others count under a key nothing reads, 06 §3.2); a step-up code,
  once the per-user step-up limits passed (over the caps the challenge is still created, never
  emailed, and the answer is the same `202`); and the account-deleted confirmation, after the
  account is deleted (over the caps it is skipped and the deletion stands, 06 §7);
- `INVITE_EMAILS_GLOBAL_DAY` (*I*): an invite email, counted for real only for an address that may
  be mailed and passed the inviter's caps (06 §6.6);
- `NUDGE_EMAILS_PER_DAY` (*N*): a claimed "It's your turn" nudge (03 §7).

A new kind of email MUST count toward one of them, or add a day cap of its own to the sum below. A
source scan in the tests lists every call that sends an email, in the server and both runtimes,
with the counting it goes through, so an uncounted send fails CI.

**Each cap lets out at most twice its figure in any 24 hours.** The caps are sliding windows over
fixed UTC days (two adjacent days, the previous one weighted by how much of it the last 24 hours
still overlap). A message is sent only while the estimate with that message counted is at or
below the cap, and the estimate is never below the current day's own count, so no fixed UTC day
sends more than the cap *L*. Counting is an atomic increment that returns the new count, so two
concurrent requests can't both take the last place; the nudge sweep, which reads its room once per
run, also checks the count each claimed nudge adds and doesn't send one that goes over (03 §7), so
overlapping runs can't either. Any 24 hours overlap at most two fixed UTC days, so they send at most
2*L*, and 2*L* is reachable: *L* in the last minutes of one day, then, as that day's weight fades,
*L* more through the next. Fixed UTC-day windows on their own would allow the same 2*L* in the 24
hours around midnight, and Gmail's quota is a rolling 24 hours, so the caps are sized on 2*L*. The
invite cap's stop for the rest of the UTC day (§4) doesn't change this, since the next day starts
afresh. The hourly sign-in cap (200 / h, so at most 25 × 200 in any 24 hours, which touch 25 fixed
hours) is above 2*C* and isn't counted.

**Sizing.** In any 24 hours the instance sends at most *W* = 2 × (*C* + *I* + *N*). With the
defaults, *W* = 2 × (500 + 100 + 150) = **1,500**, against the `gmail` provider's 2,000 messages
a day (09 §2): a margin of 500, a quarter of the quota. The margin absorbs:

- the time between counting and sending: a message is counted at its request's time and sent
  moments later, after the response, and a sweep run counts its nudges at the run's start and sends
  them over up to a few minutes, so a 24-hour span of *send* times can hold a few messages more
  than *W*;
- Google's limits being approximate and subject to change without notice, and lower for some
  accounts (a Workspace trial allows 500 a day: set `EMAIL_DAILY_QUOTA`, below).

Nothing else uses the sender user's quota: it is dedicated to one instance and never used
interactively (09 §2), and a message Gmail refuses with `401` is retried once only after it was
refused. An operator who points `smtp` at Google's SMTP relay with the same Workspace user shares
that user's quota, and sets `EMAIL_DAILY_QUOTA` for it.

**Sign-in comes first.** Each kind keeps its own cap rather than drawing on one shared budget, so
invites and nudges at their worst can't use up the room sign-in codes have, and because *W* stays
under the quota the provider never refuses a code for quota. Sign-in has two thirds of the budget.
Draining the sign-in cap itself is a denial of service on sign-in, accepted as F-12 until
Turnstile is enforced (M4), and not something this budget prevents. It is cheap: requests to
distinct addresses pass the per-email limits, so only the per-IP limit stands in the way, 20 an
hour per IPv4 address (480 a day) and 80 an hour per IPv6 /56 (§4.1); about two IPv4 addresses, or
one IPv6 /56, keep sign-in codes shut at 500 a day, and refused requests still count, so the cap
stays shut while they keep asking. The budget bounds what raising the cap may cost: no higher than
`EMAIL_DAILY_QUOTA` allows.

**Startup check.** `EMAIL_DAILY_QUOTA` (09 §1) is the provider's limit on messages in any 24 hours:
2,000 by default for `gmail`, unset for the other providers. When it is known, the configuration is
refused unless *W* ≤ `EMAIL_DAILY_QUOTA`, so raising one of the three caps means lowering another
or stating a larger quota; the error lists each cap as `NAME=value`, *W* with its sum, and the quota
and where it came from (set, or the provider's default). With no
quota known (another provider and `EMAIL_DAILY_QUOTA` unset) nothing is checked; operators of other
providers set it to their plan's daily limit.

**Why not strict counting.** Summing the last 25 hourly buckets would bound any 24 hours by *L*
rather than 2*L*, almost doubling the usable volume, but needs a 25-row counter read on every
sign-in request, under the same-statements parity of 06 §3.2. At friends-and-family volumes the
sized defaults leave ample room (500 codes a day), so the simpler sizing is used; an instance that
needs more than half its provider's quota should move to strict counting or a transactional
provider with a larger quota.

## 5. Privacy

- Collect only: email, display name, the age-confirmation time, game data, uploaded word lists
  and their rights attestations, session metadata (user agent; HMAC'd IP in audit events).
- Minimum age `MIN_AGE` (default 13) confirmed at onboarding (06 §5). The privacy page states it,
  says children play only through a parent's or carer's account, and user-facing copy doesn't
  market the service to children. A privacy review is required before any child accounts (Q20,
  roadmap M7).
- No third-party scripts, analytics, fonts or CDNs in the client (sole optional exception:
  Turnstile, when the operator enables it — disclosed on the privacy page).
- Emails are never shown to other players except: the invitee sees the inviter's email in the
  invite email (disclosed to the inviter beforehand), and the creator sees the addresses they typed
  themselves until those seats are accepted.
- Retention: auth events 90 days; expired OTPs/sessions deleted by sweep; `invite_email` cleared on
  terminal invite states, and the `invites` table stores only the `emailId` HMAC; account deletion
  per 04; logs and backups per the operator's documented
  retention (09 §4–5), stated on the privacy page.
- **Email provider copies** (accepted residual for the proof of concept): the Gmail provider can't
  avoid Gmail keeping a copy of every sent message in the sender user's *Sent* folder — every OTP,
  every typed invitee address and who invited whom — and replies and bounces land in that mailbox.
  Mitigations: a dedicated sender user used for nothing else and never interactively, with 2-Step
  Verification on and IMAP and POP disabled, and the operator purges its *Sent* folder regularly
  (or applies a retention rule, if their Workspace edition supports one). The privacy page states
  that the email provider keeps copies of sent messages and for how long, allowing for the 30 days
  purged mail stays in Trash and for any Vault hold. Move to a transactional provider before the instance grows beyond
  friends and family (Q2).
- A privacy page (`/privacy`) is part of the app; operator contact comes from config.

## 6. Supply chain and CI

- Lockfile committed; `pnpm install --frozen-lockfile` everywhere.
- Install scripts: pnpm's `allowBuilds` allow-list (pnpm 12's name for `onlyBuiltDependencies`)
  set explicitly (e.g. `esbuild`, `workerd`); all others blocked. Runtime Docker image built with `pnpm deploy --prod`.
- Minimal runtime deps, each justified and permissively licensed (allow-list checked in CI, 11 §6);
  OSV-Scanner on the lockfile in CI and nightly, with every ignore in `osv-scanner.toml` pointing at
  an accepted-risk entry (with an expiry) in `docs/security/findings.md`; dependency updates via
  Renovate (11 §8) with a minimum release age (3 days) and **no automerge of anything**: dev
  dependencies (test and build tools shape the production bundle), lockfile maintenance and runtime
  dependencies all go through the normal review.
- **Renovate's token** (`RENOVATE_TOKEN`, a project access token with the Developer role, no merge
  rights on protected `main`) is a masked, protected variable **scoped to a `renovate`
  environment**, used only by the scheduled Renovate job; Renovate runs with `ignoreScripts: true`.
  No job that runs dependency code (lint, test, build) can read it.
- Secret scanning: gitleaks in CI and as a pre-commit hook, with a rule for the `ym_pat_` token
  prefix (06 §8). Forge push protection doesn't know the prefix (06 §8), so gitleaks is the control.
- **Our GitLab is Community Edition, which has no protected environments.** Secrets are therefore
  confined by two settings that CE does have, used together: the variable is **protected** (only
  pipelines on protected refs receive it: `main`, which only Maintainers can push or merge to, and
  tags matching `v*`, protected so only Maintainers can create them) **and environment-scoped**
  (only jobs that declare that environment receive it). An MR pipeline gets neither.
- **Publishing** packages (`@your-move/*`, 02 §7.4) and images happens only in jobs on `main`/tags
  that declare the **`release` environment**, with credentials held in masked, protected variables
  scoped to that environment: packages with a **deploy token** (`write_package_registry`), images
  with a **Maintainer-role project access token** limited to `read_registry` and `write_registry`
  (no `api`), because protected container repositories refuse deploy tokens, which have no role —
  **never `CI_JOB_TOKEN`**, which every pipeline (including MR and Renovate
  pipelines running new dependency code) receives with the triggering user's rights. GitLab
  **protected packages** for `@your-move/*` and **protected container repositories** (the
  `applications/your-move*` path rule) require the Maintainer role to push, so a Developer-level
  token or a compromised MR job can't publish over a release; deleting through the protected
  container path needs Owner (our CE's package rule takes no delete level).
  Both protection features exist on our CE version. M1 verifies that the deploy token can publish
  protected packages; if not, packages take the same fallback images already use (findings.md
  F-9): a Maintainer-role project access token, with protected variables and protected refs as the
  only confinement. M0/M1 acceptance proves the release credentials publish from `main` and that
  an MR pipeline can't read them.
  No developer publishes from a workstation. Image signing is a later decision (cosign keyless
  needs an OIDC issuer Sigstore trusts; a self-hosted GitLab isn't one); until then deployments
  **pull images by digest**, recorded in the release notes (from M1; until then in the publish
  job's output), and every package/image records the commit and pipeline that built it.
- CycloneDX SBOMs, kept as pipeline artifacts: one for every Docker image built on `main` and tags
  (from the image itself), and one for what each deployment ships, the union of the production
  dependency closures of the root (installed games), the web app and the Node server or the
  Worker.
- CI images and Docker base images pinned by digest.
- **Runners**: the instance's shared runners (amd64 and arm64) aren't protected, so MR jobs and
  `main` jobs share hosts. Jobs therefore run unprivileged: no Docker-in-Docker, images built with
  rootless BuildKit (or kaniko) natively per architecture; secrets exist only in the `release`,
  `renovate` and `production` environments (protected + environment-scoped variables, above). Accepted risk (findings.md): code from an MR job could
  try to persist on a shared runner host; protected runners for release jobs are an owner-side
  improvement if the instance gains more runners.
- Cloudflare deploy credentials: `CLOUDFLARE_API_TOKEN` is a **protected + masked** GitLab variable
  scoped to a `production` environment, so only jobs on protected refs that declare it receive it.
  The token is scoped to one account with only Workers Scripts:Edit and D1:Edit. **No dependency
  or game-package code runs while it is in the environment**: the deploy job uses the stage-3
  artifact, doesn't run `pnpm install`, doesn't run `pnpm games:verify`, and its orphan check
  (`pnpm games:check-db`, 02 §7.3) reads only the plain-data `generated/installed.json` plus one
  fixed D1 query — it never imports a game package's engine or manifest.

## 7. Security process

- The **security-reviewer** agent reviews every milestone diff against this document before merge.
- Findings and accepted risks are tracked in `docs/security/findings.md` (status: open / fixed /
  accepted-risk with rationale). Initial accepted risks: per-email verify lockout DoS (06 §3); the
  N-player past-opponent spread noted under T20; the T4 residuals (sign-up followed by accept or
  decline); Gmail *Sent*-folder copies of every email (§5), until a transactional provider is used;
  installed game packages are fully trusted (T27); operators control the admin list, and admins
  playing on their admin account (T30); AI help can't be prevented, only made visible (T31); shared,
  unprotected CI runners (§6).
- `SECURITY.md` at repo root describes how to report vulnerabilities, with a contact placeholder
  until the project has a public security contact.
