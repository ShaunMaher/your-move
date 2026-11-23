# 08 — Security

Small hobby-scale service, but it holds email addresses, sends email on users' behalf, and is open
source (attackers can read the code). Design so that reading the code doesn't help.

## 1. Assets

1. Users' email addresses (PII) and the social graph (who plays whom).
2. Account access (sessions).
3. Our email-sending reputation / domain (abuse → blocklisting → OTPs stop arriving → nobody can
   sign in).
4. Game integrity (hidden hands, bag/deck order, secret actions; fair turn enforcement).
5. Operator secrets (`APP_SECRET`, VAPID private key, email provider key, Cloudflare API token).
6. Licensed and uploaded word lists (`serverOnly` dictionaries) and their rights attestations.
7. **Minors' safety and privacy**: children may play through a parent's account (Q20); a game is
   aimed at groups of kids. No stranger should be able to contact them (T20, T24).

## 2. Threats and required controls

| # | Threat | Controls (MUST unless stated) |
|---|---|---|
| T1 | OTP brute force | 6-digit codes, 5 attempts/challenge, atomic attempt counting (06 §3.1), per-email and per-IP-prefix limits, global circuit breaker, constant-time compare, codes HMAC-hashed at rest |
| T2 | Email bombing a victim / OTP spray across many addresses | per-email request limits with silent drop (no challenge created); per-IP-prefix limits; **instance-wide OTP email cap** (§4); optional Turnstile, auto-enabled by the circuit breaker |
| T3 | Spam via invite emails (using us as a relay), incl. Sybil accounts | sign-in required; fixed template; display-name restrictions (06 §5); per-inviter, new-account, per-target and **instance-wide** invite caps; suppression list + one-click unsubscribe; inviter identity shown in email |
| T4 | Account enumeration | `/otp/request` identical response *and* timing parity (06 §3.2); `/otp/verify` errors indistinguishable with dummy HMAC; the in-app "not a player" lookup is authenticated + rate-limited (accepted residual risk, 06 §6) |
| T5 | Session theft / lingering access | `__Host-` cookie, `HttpOnly`, `Secure`, `SameSite=Lax`; tokens hashed at rest; sessions list + revoke; logout-all; revocation also kills push subscriptions and live sockets (06 §4); step-up OTP for account deletion |
| T6 | CSRF | `SameSite=Lax` + strict `Origin` check on every state-changing request and the WebSocket upgrade; JSON-only bodies (05 conventions). Exemptions are listed explicitly: the unsubscribe routes (Origin and JSON) and the dictionary upload route (JSON only). No state change on GET — including timeouts (sweep only) and unsubscribe (GET shows a page). |
| T7 | XSS / HTML injection | React escaping only; **no `dangerouslySetInnerHTML`** (lint rule); strict CSP (§3); display names treated as untrusted everywhere, including email HTML templates (escaped) and push payloads (plain text) |
| T8 | Cheating: reading hidden information (other hands, bag/deck order, secret actions) | Game data leaves the server only via module `view()`, the viewer's own `final_views` entry, public `record`s and `describe` text (04 invariant 4); generic perturbation test for every module covering views, summaries, `toAct`, `seatStatus`, error codes and details (including for illegal actions) and records (02 §6); `state`, `rng` and raw actions never serialised; `500`s carry no detail and logs never contain inputs, state or validator "received" values (09 §5); WebSocket carries only invalidations, to members only |
| T9 | Cheating: illegal moves, acting out of turn, replaying requests | Framework enforces membership (04 §Membership, so rows from before seat renumbering never grant access), `toAct` and `expectedVersion` + `write_token` transitions (03 §5.2); module schema + `validate` re-check every action server-side; client previews are never trusted |
| T10 | Predictable shuffles | WebCrypto-backed `RandomSource` + unbiased Fisher–Yates; seeded sources exist only in tests |
| T11 | IDOR | **Every user-owned row** (games via membership, sessions, push subscriptions, blocks, settings, uploaded dictionaries, join links via the game's creator) is queried scoped by the session's `user_id`. Using a resource in a new game is authorised by `ResourceProvider.authorizeForNewGame` (02 §2.1): someone else's or a deleted upload looks exactly like an unknown id. Blocks can only target past opponents or co-members. Non-owned resources return `404`. Tests use foreign, deleted and nonexistent ids. |
| T12 | Push endpoint SSRF / abuse | Parse with `URL`; require `https:`, no userinfo, no explicit port other than 443, hostname not an IP literal; host must equal or be a label-boundary suffix of an allow-listed push service (`push.apple.com`, `fcm.googleapis.com`, `notify.windows.com`, `push.services.mozilla.com`) — e.g. `x.push.apple.com` ✓, `evilpush.apple.com` ✗, `push.apple.com.evil.tld` ✗. Outbound fetch with `redirect: "manual"` and a 5 s timeout. Keys validated (P-256 point, 16-byte auth). ≤ 10 subscriptions/user. |
| T13 | DoS / resource abuse | Body size limit (16 kB), placements ≤ rackSize, rate limits on all write endpoints, game count caps (counted against the creator only), WebSocket per-user cap, per-IP upgrade limit, 1 KiB WS message cap, Cloudflare's edge protection on CF target |
| T14 | Email header injection | Recipient addresses validated by schema; subject/body from templates; provider HTTP APIs (structured JSON); SMTP via a library, never hand-built headers |
| T15 | Secret leakage | Secrets only from env/secret bindings; `.dev.vars`/`.env` git-ignored; logs never contain OTPs, tokens, cookies, request bodies, raw or masked emails (only the HMAC `emailId`) |
| T16 | Supply chain | See §6 |
| T17 | Unsubscribe-link forgery | HMAC-signed, purpose-bound tokens (05 §Email links); GET shows a page, POST changes state |
| T18 | Privacy leakage via lock-screen notifications | Push text is built only from module `describe` text of public records and display names (02 §5) — never emails or hidden state. No pushes for invitations from people who can't add the user directly, or for lobby join/leave/remove events |
| T19 | Dev-only features in production | All dev behaviour (`console` email, `/__dev/*`, non-`__Host-` cookie) gated by the single `isLocalDev(config)` predicate (06 §4), which requires the parsed `PUBLIC_URL` host to be exactly `localhost`/`127.0.0.1`/`[::1]` over `http`. CI test: production build returns 404 for `/__dev/emails`. |
| T20 | Harassment and unsolicited contact (incl. of minors) | `whoCanAddMe` (default: only past opponents auto-join; everyone else sends an invitation with no push, 06 §6.2); past-opponent relationships form only at game end, and link joiners pair only with the creator (06 §6.9); per-target inbound invitation cap, silently suppressed (06 §6.7); blocks checked between **every** pair of seated or invited users, on create and on join; creator can remove seats in the lobby; per-pair game-creation limits; a decline before first action that leaves too few players ends the game with no result; active-game caps count only the creator's own games; display-name rules (06 §5.1) |
| T21 | Dictionary upload abuse (resource exhaustion, zip bombs, using us as file storage, offensive names) | Streamed upload with compressed + decompressed size caps, word-count cap, strict charset/sorted validation (so arbitrary files are rejected), per-user quota counting every not-yet-purged blob, daily limits, instance-wide byte and daily caps with alert, account maturity (7 days or a finished game), temporary-key upload with orphan sweep, server-generated UUID keys (filesystem adapter rejects keys not matching `^[a-z0-9-]{1,64}$` and checks the resolved path stays under `BLOB_DIR`), separate Docker volume for blobs recommended, name validated like display names, Origin check |
| T22 | Leaking `serverOnly` word lists (licensing exposure for the operator) | No route serves list contents, blob keys or hashes (tested on every route); `distribution` checked server-side; the service worker never caches them; the preview endpoint takes only a full module action and runs every rack/structural check before any lookup (words §10.3); `serverOnly` lookups are limited **per word looked up** per user and per game (§4); only the uploader can use an upload in new games (T11); logs never contain dictionary contents. Accepted residual: a determined opponent can still probe words from their own racks, slowly |
| T23 | Copyright complaints about uploads | Uploads are private to the uploader's games; rights attestation stored; takedown contact on the help/privacy page; operator script to delete any upload (`pnpm admin:dict:delete <id>`) |
| T24 | Join-link abuse (guessing, leaked or forwarded links, joining someone's game uninvited) | 128-bit tokens stored hashed; token in the URL fragment so it never reaches logs; URL shown only on create/rotate; expire at start / revoke / rotate / lobby expiry / 7 days; sign-in and an explicit Join tap required (no auto-join after sign-in; return path kept in `sessionStorage`, same-origin `/join` only); block checks against every member; people who declined, left or were removed can't come back through the same link; lookup/join rate-limited per user and IP; indistinguishable `404`s; creator sees who joined and can remove them; link joiners don't become past opponents of other players; the share UI warns that anyone with the link can join |
| T25 | Malicious/buggy game module crashing or slowing the server | Modules are first-party code reviewed like the rest; module exceptions → `500` without partial writes (transition aborts); per-call CPU budget (≤ 5 ms p99 on reference hardware) checked by the test kit on each module's `worstCase` inputs (02 §6); `serverOnly` dictionary loads limited per user (§4) |
| T26 | Forced forfeits through game settings | The turn timeout is a framework setting, an integer 1–30 days, validated before the module sees options, and shown on every invitation and in the lobby (02 §4); a player who never acted can decline without a loss |

## 3. HTTP security headers

Applied to every response — by Hono middleware for server-handled paths and, on Cloudflare, by the
generated `_headers` file for static assets (03 §9). One shared definition generates both.

- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none';
  base-uri 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'self'; manifest-src 'self'`
  (`connect-src 'self'` covers same-origin `wss:` in current browsers; add the explicit `wss://`
  origin if testing shows otherwise.) When Turnstile is enabled: add
  `https://challenges.cloudflare.com` to `script-src` and `frame-src`. No `unsafe-inline` or
  `unsafe-eval` in production (07 §4 build settings).
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
| **OTP emails instance-wide** | 200 / h, 1,000 / day | silent; alert; auto-Turnstile if configured |
| **Failed verifies instance-wide** | 500 / h | alert; auto-Turnstile if configured |
| Opponent lookup (`POST /games` with email) per user | 30 / h (both outcomes) | `429` |
| Game creation per pair / per user | 5 / day / 30 / day | `429` |
| Invites per inviter | 5 / day, 20 / 30 days (2 / day for new accounts, 06 §6.6) | `429` |
| Invites per target address (by email HMAC) | 3 / 30 days | silent (game still created) |
| **Invite emails instance-wide** | 100 / day | silent; alert |
| New accounts per IP (bucketed) | 10 / day | silent on `/otp/request` for unknown emails from that bucket |
| WebSocket upgrades per IP | 30 / min | `429` |
| Moves per user | 120 / min | `429` |
| Preview per user | 300 / min | `429` |
| `serverOnly` dictionary lookups per user (counted per word looked up, in `validate` and `preview`) | 60 / min, 2,000 / day | `429` |
| `serverOnly` dictionary lookups per game | 5,000 / day | `429` |
| Distinct `serverOnly` dictionary loads caused per user | 6 / h | `429` |
| Invitations received from non-past-opponents, per target | 3 / day | silent (`suppressed`, 06 §6.7) |
| Dictionary uploads per user | 5 / day (quota: 3 lists / 24 MB not yet purged) | `429` / `409` |
| **Dictionary uploads instance-wide** | 50 / day, `LIMIT_DICT_TOTAL_BYTES` (default 2 GB) stored | `503`; alert |
| Join-link lookups/joins per user | 30 / h | `429` |
| Join-link lookups per IP (bucketed) | 60 / h | `429` |
| Join-link creations per user | 20 / day | `429` |
| Any authenticated write per user | 300 / min | `429` |

Instance-wide numbers are sized for a friends-and-family deployment; operators raise them in config.
"Alert" = an `error`-level structured log with a stable `alert` field, so it can be wired to
whatever notification the operator uses.

### 4.1 Client IP and bucketing

- **Source of the client IP**: Cloudflare → `CF-Connecting-IP`. Node → the socket address, or, only
  when `TRUST_PROXY=true`, the entry `TRUST_PROXY_HOPS` positions from the **right** of
  `X-Forwarded-For` (the leftmost entries are attacker-controlled). If the header has fewer entries
  than hops, use the socket address.
- Node startup warning when `TRUST_PROXY=false` and all recent requests come from private/loopback
  addresses (likely a misconfigured proxy, which would put every user in one bucket).
- **Normalise** IPv4-mapped IPv6 (`::ffff:a.b.c.d`) to IPv4 *before* bucketing.
- **Buckets**: IPv4 → the /32. IPv6 → three layered keys, all checked: /64 at the listed limit,
  /56 at 4×, /48 at 10×.
- Keys store `HMAC(K_ip, bucket)`, never raw IPs.
- Unit tests cover mapped addresses, XFF parsing with spoofed left entries, and IPv6 layering.

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
  invite (disclosed to the inviter beforehand).
- Retention: auth events 90 days; expired OTPs/sessions deleted by sweep; `invite_email` cleared on
  terminal invite states, and the `invites` table stores only the `emailId` HMAC; account deletion
  per 04; logs and backups per the operator's documented
  retention (09 §4–5), stated on the privacy page.
- A privacy page (`/privacy`) is part of the app; operator contact comes from config.

## 6. Supply chain and CI

- Lockfile committed; `pnpm install --frozen-lockfile` everywhere.
- Install scripts: pnpm's `onlyBuiltDependencies` allow-list set explicitly (e.g. `better-sqlite3`,
  `esbuild`, `workerd`); all others blocked. Runtime Docker image built with `pnpm deploy --prod`.
- Minimal runtime deps, each justified and permissively licensed; `pnpm audit --prod` in CI;
  dependency updates via Renovate with a minimum release age (e.g. 3 days) and no auto-merge for
  runtime deps.
- CI images and Docker base images pinned by digest.
- Cloudflare deploy credentials: `CLOUDFLARE_API_TOKEN` is a **protected + masked** GitLab variable
  scoped to a `production` environment that only the default branch/tags can deploy to. The token
  is scoped to one account with only Workers Scripts:Edit and D1:Edit. The deploy job uses the
  already-built artifact and does not run `pnpm install` (no dependency scripts execute with the
  token in the environment).

## 7. Security process

- The **security-reviewer** agent reviews every milestone diff against this document before merge.
- Findings and accepted risks are tracked in `docs/security/findings.md` (status: open / fixed /
  accepted-risk with rationale). Initial accepted risks: in-app account-existence lookup (06 §6);
  per-email verify lockout DoS (06 §3).
- `SECURITY.md` at repo root describes how to report vulnerabilities (operator contact placeholder
  until a name/domain exists).
