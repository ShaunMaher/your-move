# 10 — Roadmap

Each milestone goes through the agent loop in `CLAUDE.md`: **coder → picky reviewer → security
reviewer → coder fixes → owner sign-off**. A milestone is done only when its acceptance criteria
pass in CI.

## M0 — Skeleton and engineering standards
The project's foundation, built to 11 (engineering standards) from the first commit.
- Toolchain: `mise.toml` (Node 26 LTS, pnpm 12, plus gitleaks, osv-scanner and oasdiff),
  `packageManager`, `engines` (11 §1).
- pnpm monorepo per 03 §3 with every package directory created (empty packages export a
  placeholder and a test; placeholders are knip-ignored with the milestone that fills them, 11 §6),
  `@your-move/*` scope, TypeScript project references and the strict settings (11 §2). Every
  placeholder package, including those that will be published (`sdk`, `testkit`, `api-client`,
  `mcp`, the games), is **`"private": true`** until the milestone that fills it removes the flag,
  so the first `main` pipeline can't publish `0.0.0` placeholders.
- Quality tooling (11 §3–§6): Prettier, ESLint flat config (typescript-eslint strict type-checked,
  React, hooks, jsx-a11y, import rules, eslint-comments), dependency-cruiser architecture rules
  (11 §5, including the game-package ruleset in `packages/testkit`), knip, licence check, gitleaks,
  OSV-Scanner, `.editorconfig`, `.gitattributes`, `CODEOWNERS`, `SECURITY.md`.
- Tests wired (11 §4): Vitest workspace with coverage thresholds, fast-check, Testing Library,
  Playwright (WebKit iPhone + Chromium) with one smoke test, the API contract-test harness running
  against both runtimes.
- Git workflow (11 §7): lefthook hooks, commitlint, Changesets without a bot (no packages published
  yet; `release/<date>` flow documented).
- Renovate configuration (11 §8: no automerge, `:semanticCommits`, `ignoreScripts`) and its
  scheduled job in the `renovate` environment, the only job that receives `RENOVATE_TOKEN`.
- `.gitlab-ci.yml` with every stage in 11 §9 in the order validate → test → build → e2e → security
  → publish → deploy; unprivileged jobs, native per-arch image builds with kaniko (or rootless BuildKit) on the
  `arch-amd64` / `arch-arm64` runners; publish jobs in the `release` environment (protected,
  environment-scoped variables; GitLab CE has no protected environments, 08 §6) using the release
  credentials (failing clearly when they aren't configured; nothing to publish yet).
- `apps/worker` and `apps/node` both serve `packages/server`'s Hono app and the Vite SPA shell.
  The API skeleton is versioned from the start: `GET /api/health` and `GET /api/v1/health`,
  `GET /api/v1/config` (so the shell takes its title from config, 03 §9),
  the OpenAPI document at `/api/v1/openapi.json` (no rendered docs page, 05 §Versioning),
  `@your-move/api-client` generated from it (`openapi-typescript` + `openapi-fetch`) and used by
  the SPA's health check, and the `oasdiff` breaking-change check.
- Instance composition plumbing (02 §7.3): `instance.config.ts` (empty game list); `pnpm
  games:generate` writing the git-ignored `generated/` (server registry, client import map and
  `installed.json`) that `apps/*` inject into `createApp({ platform, games })`, run from the root
  `prepare` script and before typecheck, lint and test (11 §3); `pnpm games:check-db` reading only
  `installed.json`; and the **M0 subset** of `pnpm games:verify`: duplicate or invalid type ids, the
  SDK peer-range check, the licence allow-list with `acceptLicence`, the dependency rules of
  02 §7.1.1 (the SDK, `zod` and `react` as peers only, nothing else as a peer, other
  `dependencies` reachable only from the client), and the import ruleset, each unit-tested
  against fixture packages, plus a `--fast` flag that is accepted and documented. The
  test-kit run, the manifest-vs-engine check, icon sanitisation, the built-output ESLint rules and
  the real fast/full split need the SDK types and kit, so they land in **M1**.
- Config schema with secret redaction + `.env.example`; shared security-header definition applied
  on Node and emitted as `_headers` for Cloudflare.
- Docs: README quick start, CONTRIBUTING (dev setup, commands, conventions, review process), the
  first three ADRs (11 §10), `docs/guides/writing-a-game.md` stub.
- **Accept:** a fresh clone + `mise install` + `pnpm install` + `pnpm dev:node` / `pnpm dev:worker`
  serves the SPA and the health endpoints; stages 1–5 of 11 §9 (the ones that run on MRs) are green
  on an MR; each gate is shown to fail by **fixture tests run in CI** against the real configs (a
  lint error, an architecture-rule breach such as an engine importing `node:fs` or using
  `Math.random`, a coverage drop, a fake `ym_pat_` string, a disallowed licence, a breaking OpenAPI
  change, a commit message not in Conventional Commits form); end-to-end tests run against the
  **Node build output** (`node apps/node/dist`), not the image; the Docker image builds natively for
  amd64 and arm64 without privileged jobs (MR pipelines build but never push); **the image runs**:
  checked on `main` by the post-push smoke job (09 §6), and locally once with `docker build` +
  `docker run` and a `/api/health` request, recorded in the MR; header test passes on both targets;
  Renovate's first run (manual trigger of the scheduled job) opens its Dependency Dashboard; and
  no MR-pipeline job can read `RENOVATE_TOKEN` or the release and production variables (a CI check
  that prints only whether each variable is set, run on an MR).

## M1 — Game SDK + words engine + dictionary
- `@your-move/sdk`: `GameDefinition` / `GameClientModule` / `GameManifest` types, recording
  `RandomSource`, `Resources`; `@your-move/testkit`: the generic test kit (02 §6: schema, replay,
  perturbation secrecy, termination, turn sanity, CPU budget, cross-game isolation; fast and full
  modes) and the game-package built-output rules (02 §7.5: dependency-cruiser ruleset and the
  engine ESLint config). The SDK is **0.x** until M4 (02 §7.4), exports the client-facing API types
  and re-exports zod as `@your-move/sdk/schema`, with React helpers only at `@your-move/sdk/client`;
  the API Extractor report is committed. `pnpm games:verify` gains the rest of its checks (the kit,
  manifest-vs-engine, icon sanitisation, built-output ESLint rules on engine and manifest output,
  fast/full modes). Once real games are composed, the builds close the gap between what
  `games:verify` checks and what bundlers read: after the web, Node and Worker builds, every
  bundler metafile input under an installed game package's directory must be a file
  `games:verify` checked, or the build fails. Publishing to the GitLab package registry happens
  from `main` after merge (11 §7). **Accept (release path):** with GitLab protected packages for
  `@your-move/*` and protected container repositories configured (both exist on our CE version,
  since M0), the release credentials publish from `main` through them (if protected packages refuse
  the deploy token, the F-9 fallback is applied to packages and recorded), and an MR pipeline can
  neither read them nor publish; give the two publish jobs separate environment scopes so each sees
  only its own credential (F-8).
- **The reference game package** `@your-move/game-example` (02 §7.6): exercises everything the
  word game doesn't — 2–4 players, a hidden hand, elimination, and one simultaneous secret phase
  (multi-seat `toAct`). It proves the contract and kit before the word game uses them, drives the
  M3 framework tests, and is the template for third-party authors. `docs/guides/writing-a-game.md`
  written around it.
- **Broken fixture modules** (02 §6) that the kit must reject.
- `words` ruleset schema, registry, behaviour variants (`swapOrder`), and the two MVP rulesets `classic` and
  `casual` (words §8.3) with original, symmetric premium layouts.
- Dictionary registry + build (per-dictionary `meta.json`, checksum, additions/removals, compact
  output, alphabet manifest), `DictionaryProvider`, lookup, and the ruleset↔dictionary compatibility
  check. MVP dictionary: `enable`.
- `words` engine as a `GameDefinition` (games/words.md §10): setup/deal, placement validation, word
  finding, scoring, swap/pass, resign/timeout, end conditions, final scoring, view, preview —
  packaged as `@your-move/game-words` with its manifest (02 §7).
- Releases: `v*` tag pipelines create a GitLab Release that records the image digests and the
  package versions published.
- Release path: Changesets bumps a package **major** when a peer dependency it names is bumped
  out of range, so an SDK minor would take `@your-move/testkit` (peer `@your-move/sdk` `^0.x`) to
  1.0.0 and break "0.x until M4". Settle how the testkit and the SDK are versioned together (e.g. a
  `fixed` group, or `onlyUpdatePeerDependentsWhenOutOfRange` with a peer range spanning `0.x`)
  before the second SDK release; the first (0.1.0, M1a) bumped both together by hand.
- **Accept:** a Maintainer-triggered MR pipeline's `CI_JOB_TOKEN` cannot push to a protected
  container repository or an `@your-move/*` package version (if it can, protection is raised to
  Owner, the release registry token is reissued with the Owner role, and the release credentials
  are confirmed to still publish; F-9);
  the kit fails every broken fixture and passes the reference module at 2, 3 and 4
  players; `pnpm games:verify` passes with `example` and `words` installed and fails when either
  violates an architecture rule; a game package built in a separate scratch repository from
  `pnpm pack` tarballs of the SDK and testkit, following the guide, passes the kit and the
  built-output rules; words engine passes the generic test kit (including the CPU budget on `worstCase`
  inputs) under every ruleset; ≥ 95 % line coverage on
  engines and SDK; table-driven tests for every rule in games/words.md incl. edge
  cases (cross-words only, blanks on premiums, two DW stacking, bingo, extending existing words,
  first move rules, game end variants, both `swapOrder` variants, each MVP ruleset's tile table
  and premium counts); property tests run under **every** ruleset: tile conservation and replay invariants
  over thousands of random legal games played by a simple bot (seeded `RandomSource`). Measured
  dictionary lookup CPU and Worker startup time recorded.

## M2 — Auth
- DB schema + migrations on both drivers; repository interfaces + both adapters + shared repository
  contract tests; `Platform` for both runtimes; HKDF subkeys; `isLocalDev` predicate.
- OTP request/verify, sessions, display-name onboarding (the age confirmation and its rules arrive
  in M4), logout/logout-all, `/me`, rate limiting, email providers (`console` and `smtp`; `gmail`
  arrives in M4, Q2), security headers, Origin checks (cookie requests only; bearer tokens arrive in
  M3).
- Step-up codes for account deletion (06 §7). No admin surface yet beyond `ADMIN_EMAILS` config:
  the Admin API needs admin tokens, which arrive with API tokens in M3.
- Sign-in UI + welcome screen, PWA manifest/icons/service worker basics.
- **Accept:** integration tests for every 06 §3–§4 rule (expiry, attempts, 3-live-challenge behaviour,
  silent per-email drop creates no challenge, enumeration response *and* timing parity, rate limits
  incl. IP bucketing/XFF parsing, global caps); 50-parallel-verify race test on both drivers;
  logout-all test; Origin/JSON enforcement tests; `/__dev/emails` 404 in production config;
  zero CSP violations in Playwright; verified on a real iPhone home-screen install that sign-in
  persists across app restarts and that the home-screen label uses the runtime `APP_NAME`.
- **Deferred from M2b (the server half, review round 1), each with its target:**
  - `smtp`: pending **Q26** (the library's MIT-0 licence is an owner/legal decision). Until a
    sending provider exists (`gmail` in M4, or `smtp` once Q26 is decided) only `console` sends,
    so **M2 can't be accepted** — the real-device sign-in check needs real email — before then.
  - `GET /api/v1/me/sessions` and `DELETE /api/v1/me/sessions/:id`: M2c (with the sign-in UI).
  - `settings` in `PATCH /api/v1/me` (`emailNudges`, `whoCanAddMe`, `theme`): `emailNudges` in
    alpha A6, default off (03 §7); `theme` in alpha A9; `whoCanAddMe` in M4.
  - Turnstile: not built; configuring `TURNSTILE_*` refuses to start until it is (M4). The global
    caps alert instead (F-12).
  - Account deletion's game steps, `deletion_requested_at` and nulling `admin_audit.target_id`
    (04 §Account deletion): M3, with games and the Admin API.

## Alpha — the first playable release (a cut across M2–M4)

The first thing a real person plays: two people who each sign in with an emailed code play a full
words game against each other, on phones, on the proof-of-concept deployment (09 §4). The alpha is
built **before** the rest of M3 and M4, from these slices; each is a branch with its own review,
and slices without a dependency on each other are built in parallel.

| Slice | From | Contents | Depends on |
|---|---|---|---|
| A1 — sign-in UI | M2 | Sign-in screens (email → code), display-name onboarding, welcome screen, sign out; PWA manifest, icons and service worker basics | M2b |
| A2 — framework core | M3 | Games registry, the inbound invitation cap (08 T20, 06 §6.7) and lazy expiry of overdue lobbies (since the alpha has no blocks and no sweep), game storage repositories, the lifecycle needed for one game between existing users (create with options, invite an onboarded user per `whoCanAddMe`, accept, decline, start, submit and preview, resign, finish with final views and ranking), `toAct`, the game envelope and history endpoints, catalog/config/rules endpoints, the built-in dictionaries through `DictionaryProvider`, the error table, the OpenAPI document; the M3 transition race tests and route-wide secrecy test for what this slice ships | M2b |
| A3 — words board UI | M3 | The words `GameClientModule` (02 §3): board, rack, tap-to-place and drag, blank picker, live preview, shuffle/recall, swap/pass/resign dialogs, the view-level play analysis; built against the shell contract with component tests, so it doesn't wait for A2 | M1b |
| A4 — shell UI | M3 | Game list, new-game flow (game picker → options → players), lobby, game frame (header, menu with resign — a confirm dialog, then the API's resign call; 02 §3 keeps resign out of the module — history drawer, finished screen), lazy module loading, the public word list's download and cache for the module's previews; the players step says the other person must have signed in first (A2 seats only onboarded users; the onboarding claim of an address's seat stays in M4); catalog icons rendered as `<img>` from a `data:` URL, never inline SVG; Playwright two-player words game, including a resignation, on the WebKit iPhone viewport | A1, A2, A3 |
| A5 — deployment | M4 | `gmail` provider and the shared MIME builder (with T14's hostile-name tests), `docker-compose.tunnel.yml` with `*_FILE` secrets and the tunnel acceptance tests, the deploy docs for both | M2b |
| A6 — email nudges | M4 | The optional "It's your turn" email nudge (03 §7): `settings.emailNudges` in `PATCH /api/v1/me` (default off) and its Settings toggle, `users.email_id`, the unsubscribe route with `List-Unsubscribe` and RFC 8058 one-click (05 §Email links, T17), and a `sweep()` with only its "send due email nudges" step, run by a Node `setInterval` and the Worker's Cron Trigger (03 §8); tests for the token, the one-click POST, the 24 h and once-a-day rules, suppression, provider failure and the nudge text (T18) | A2, A5 |
| A7 — install guide | M4 | The `/install` screen (07 §1, §4): "Add to Home Screen" steps for iOS Safari, a note for Android Chrome and an "already installed" state, and the dismissible banner that points iOS Safari visitors to it; component tests and a Playwright check on the WebKit iPhone viewport | A1, A4 |
| A8 — turn notifications | M4 | Web Push for "your turn" and "game over" (03 §7, 02 §8): RFC 8291 encryption and RFC 8292 VAPID on WebCrypto in `packages/server`, sent in the background after the transition and never to its actor; `push_subscriptions` with its 10-per-user cap and session cascade (04), the two `/api/v1/push/subscriptions` endpoints (05) with T12's endpoint allow-list and key checks, removal on `404`/`410`, `pnpm gen:vapid` and the VAPID secrets in the tunnel compose file (09 §1); in the web app the service worker's `push` and `notificationclick` handlers, the Settings toggle with its iOS Safari explanation, the once-per-device offer after a game is created, the launch re-save and the sign-out unsubscribe (07 §4). Tests: RFC 8291's example, the VAPID token, T12's allow-list table, the cap, cascade and clean-up on both adapters, who is pushed to, payloads decrypted as a device would with no hidden state (T18), and the worker's handlers; checked by hand on an iPhone with the app on the Home Screen of the proof-of-concept deployment | A2, A4, A7 |
| A9 — theme choice | M4 | The manual light/dark override of 07 §5: `settings.theme` (`"system"`, `"light"` or `"dark"`, default `"system"`) in `PATCH /api/v1/me` (04, 05), the Settings "Appearance" choice, `data-theme` on the page's root element and the per-device `ym.theme` copy that stops a flash on launch (07 §5, 06 §4); tests for the setting on both adapters, the choice and its storage failures, and a Chromium accessibility check of the dark theme | A1, A4 |
| A10 — clearer turns | M3 | The words board's turn chip, filled acting seat and off-turn planned tiles (07 §2): the local score but no word check or request while it isn't your turn, and the plan becomes a placement in place when it is; Board and styles tests (contrast pairs) and a Playwright check that an off-turn tile is marked planned | A3 |
| A12 — past opponents | M3, M4 | Starting the next game with someone you've finished one with, without typing an address or accepting an invitation: `GET /api/v1/players/recent` (05), `{ userId }` invitees in `POST /api/v1/games` checked against `past_opponents` and blocks (`INVALID_INVITEES` otherwise, 06 §6.1), the auto-join of a picked past opponent under the default `whoCanAddMe` (an invitation instead when AI assistance is allowed, 02 §4), the start at creation when every seat is filled that way (05 Created), the per-pair limits by (creator, `userId`) (06 §6.7), the "<creator> added you to a game" push to the added player (06 §6.2, 03 §7), and the new-game players step's "People you've played" (07 §1.1). Tests: the rules above on both adapters (the repository contract and the transition race of a start at creation against the added player's decline), the route-wide secrecy test over a game started at creation, the push recipients and text, and a Playwright rematch: two people finish a game, then one picks the other and both land on the board. Stays at M4: the `whoCanAddMe` setting itself (everyone has the default, `pastOpponents`), blocking (the `blocks` table is read wherever 06 requires, but nothing writes it until M4), the generic invitation push and link joiners' "Add <name> to your players?" (join links are M4's) | A2, A4, A8 |

Not in the alpha, kept at their milestones: API tokens, the Admin API (operators use
`ADMIN_EMAILS` and the database), AI assistance, realtime (the alpha refetches on focus and on a
short poll while it's someone's turn to see), turn timeouts, reminders and every sweep step but
A6's email nudges, lobby expiry, remove seat and leave, the `whoCanAddMe` setting (A12 gives
everyone its default), email invites (and the invitation email to users with nudges on, 06 §6.2)
and join links, the invitation push (A8 sends "your turn" and "game over", A12 the auto-join
push), blocks, the
sessions list, account deletion's game steps, `MIN_AGE`, the rest of M4's settings and the polish pass (dark mode itself follows the device, and A9 adds the override). Security
controls for what the alpha ships are not cut: every slice meets 08 for its own surface, and the
M2 acceptance (including the iPhone home-screen check) is completed by A1 and A5.

**Accept:** two people sign in on iPhones by emailed code on the proof-of-concept deployment, one
creates a words game and adds the other, and they play it to the end; the slices' own acceptance
tests are green in CI.

## M3 — Framework + play words
- Cookie plus bearer on one request is refused on every route (05 §Conventions): done in M2b, so
  bearer tokens inherit it.
- Framework in `packages/server`: games registry, generic `games` / `game_players` /
  `game_actions` / `game_resources` / `past_opponents` storage, membership rules, lifecycle (lobby,
  auto-join of past opponents vs invitation per `whoCanAddMe`, accept, remove seat, start with seat
  order and block re-check, decline, leave, resign, cancel, lobby expiry), `toAct` sets and per-seat
  clocks, framework turn timeout with reminders and sweep, final views and summaries, stored
  `describe` text and the history endpoint, option resolution with remembered options, resource
  authorisation (framework `DICTIONARIES_*` config) and the `serverOnly` lookup reservation, module
  config isolation, catalog/config/health endpoints, error table (05 §Errors), all under `/api/v1`
  with the OpenAPI document and the per-game-type schema endpoint.
- The type-level test of 02 §7.4: the SDK's client-facing API schemas (`GameEnvelope`,
  `SubmitResult`, …) and the types `@your-move/api-client` generates from the routes that register
  them are mutually assignable (the routes arrive here, so the test does too).
- Game packages for real: `words` and `example` installed through `instance.config.ts`, the
  generated registry and client import map, `ENABLED_GAMES` filtering, `pnpm games:check-db` and
  the Node startup check, orphaned-game runtime behaviour (`409 GAME_UNAVAILABLE` lands before any
  game route, so a game accepted as orphaned in M2 can never be played; until M3 nothing cancels
  it), the rules
  endpoint; **a game package built outside this repo (the M1 scratch package) installs into a
  local instance** and plays. `games:verify` supplies the instance's installed dictionaries to the
  kit as resources, so the instance gate exercises the real word lists (until then the words
  engine's `test.resources` carries its kit word list, words §10.6). Measure the real dictionary's
  `has()` on 15-letter words, the longest lookups a play can make (words §10.6 worst cases).
- API tokens (06 §8): creation with per-purpose step-up codes, scopes (`read`, `play`,
  `games:create`, `join`; exclusive `admin`), the consolidated route-scope table enforced from
  `x-scope` with a deny-by-default route-enumeration test, `ym_pat_` format, HMAC storage, bearer
  auth (Origin-exempt, no cookie+bearer, header only), per-token limits, revocation incl.
  logout-all, the creation emails; `aiAssistance` option with its default rule and
  `403 AI_NOT_ALLOWED` on human seats, `via` recorded and shown in history (02 §9.3).
- Admin API (05 §Admin API) with admin tokens only: `admin_audit` with `actor_key`, `status`, user
  lookup, suspend/unsuspend (incl. cancelling the user's lobbies), revoke sessions, delete user,
  cancel a game (operator cancel, 02 §4), audit read; `pnpm admin:*` client reading
  `ADMIN_TOKEN_FILE`.
- Game shell UI: new-game flow (game picker → module options form → players), game list across
  types, lobby screen, game frame (header, menu, history drawer, finished/ranking screen), lazy
  module loading. When the web app first imports the generated client map, set
  `WEB_BUNDLES_GAME_CLIENTS` (scripts/src/games/inputs.ts) to `true`, so the bundler-input check
  requires every client entry in the web build's record (02 §7.3).
- `rng` stores `[max, value]` pairs so replay detects a changed draw range (`game_actions.rng`
  and `games.setup_rng`, 04; M1 review P-20).
- Words client module: board UI — drag & drop + tap-to-place, zoom, blank picker, live preview, shuffle/recall,
  swap/pass dialogs (resign is the shell's menu, 02 §3). The words engine exports a view-level play analysis for the board UI,
  so local previews work from the `View` alone (the engine's own analysis takes the secret state).
- Realtime: `UserChannel` DO + Node hub; refetch on visibility.
- Built-in dictionaries served through `DictionaryProvider` (03 §10): the asset-fetch `loadText`
  reads the whole body inside the load, has a timeout, and its failures are negatively cached
  briefly (M1b review S-5).
- **Accept:** transition race tests (03 §5.2 list: exactly one wins and no partial writes, both
  drivers); framework tests run with both `words` and the reference module (proves no game-specific
  code leaked into the framework), covering with the reference module: start below max, decline in
  the lobby and before/after first action (ending `declined` with no ranks and `final_views`, vs
  `out_reason = declined` excluded from the ranking, vs resignation), a timeout before a first action
  (same rule), leave, remove seat (foreign `playerId` → `404`, own row refused), cancel, lobby
  expiry, the lobby `declined` check running only on decline/leave (never on remove), `validateStart` failure
  at create, at Start and on an automatic start (trigger still succeeds), per-seat timeouts in a
  multi-seat phase (one transition per seat, stops once the game ends), reminder reset on clock
  restart, sweep idempotence, elimination shown as `out`, past-opponent pairs only between players
  who both acted;
  membership tests (users who left or were removed before start get `404`, `yourSeat` from the
  renumbered row); `whoCanAddMe` tests for both settings; a decline before a first action by the
  creator and by others (record says "declined", never "resigned"); `checkConfig` failing startup;
  the invite-claim races (03 §5.2); Playwright two-player full words game
  on WebKit iPhone viewport; route-wide secrecy test (04 invariant 4, incl. only the viewer's
  `final_views` entry); WebSocket upgrade Origin and session revocation tests;
  body-size/placement/socket-cap limits tested; p95 move latency measured; token tests (scope
  enforcement on every route, session-only routes refuse tokens, revoked/expired → `401`,
  cookie+bearer → `400`, token moves in an `off` game → `403 AI_NOT_ALLOWED` and in an `allowed`
  game shown as AI-assisted, preview allowed to a `read` token in an `off` game and drawing on the
  lookup budget, tokens never add email invitees, no CORS headers, tokens rejected in query strings
  and on the WebSocket); admin tests (non-admins and non-admin tokens get `404` on every admin route
  and aren't audited, admin tokens are exclusive and ≤ 30 days and notify every admin, every
  admin-principal request audited, lookup never echoes the email, suspension revokes sessions and
  tokens and sends the suspension notice instead of a code, `reason` never reaches players, the
  admin OpenAPI document isn't served publicly); the same API contract suite green against the
  Node and Worker builds; the web app uses only `@your-move/api-client`; `Authorization` absent from
  app logs.

## M4 — Invites, join links, notifications, polish
- Email invites (email-invite seats, claim on onboarding, lobby expiry, limits, suppression,
  unsubscribe route per 05 §Email links), with Q3's identical responses for every email case.
- Inbound invitation caps with the *Hidden invitations* list; outbound email-invitee cap.
- Join links (fragment tokens, create/rotate/revoke, landing page with explicit Join and
  `sessionStorage` return path, rate limits, block checks against every member, no re-entry after
  decline/leave/remove).
- Past opponents (picking them, auto-join and `GET /api/v1/players/recent` are alpha A12; the
  `whoCanAddMe` setting and link joiners' "Add <name> to your players?" are here), blocks,
  sessions list, account deletion (resumable).
- **Before the path game (08 §5, Q20)**: `MIN_AGE` confirmation at onboarding, the
  "don't use your full name" warning, privacy page wording about children playing through a parent's
  account, and a copy review that nothing markets the service to children.
- Web Push: the generic invitation push (06 §6.2), on the sender, endpoints and service worker
  alpha A8 built for "your turn" and "game over" (the auto-join push is alpha A12's); optional
  email nudges ("It's
  your turn" from alpha A6; the invitation email to users with nudges on, 06 §6.2).
- With bounce/complaint handling (09 §2): Settings tells a user with email nudges on when their
  address is suppressed as `bounced` or `complained`, so the toggle isn't silently ineffective.
  The alpha writes no such rows, and an `unsubscribed` row doesn't stop nudges (alpha A6 review
  P-3 and S2-1, 2026-11-25).
- The dark theme's manual override is alpha A9; accessibility pass (the install guide banner is alpha A7; the update toast is built).
- Docker deployment: `apps/node/docker-compose.tunnel.yml` (the proof-of-concept deployment behind a
  Cloudflare Tunnel, Q6) and `docker-compose.caddy.yml`, with the two-network layout and `*_FILE`
  secrets (09 §4), deploy docs (incl. the `gmail` operator setup, 09 §2), backup docs.
- `gmail` email provider (OAuth refresh token, `gmail.send` only) and the shared MIME builder.
- **Accept:** push received on an installed iPhone (first shown by alpha A8); invite → signup → game appears; account
  deletion (with step-up code) leaves opponents' history intact and passes with `foreign_keys=ON`;
  push-endpoint allow-list tests (T12, alpha A8); unsubscribe token + RFC 8058 one-click tests (T17);
  `invite_email` cleared on terminal states and no raw address in `invites`; join-link token tests
  (T24), incl. that tokens never appear in server logs and that a game with a live link or a link
  joiner never auto-starts; link joiners become past opponents only via the creator's
  confirmation; inbound-cap tests (per creator and total, `hidden` invitations listed only under
  *Hidden invitations*); **Q3 parity**: adding an onboarded user, an unknown address, an
  un-onboarded account, a suppressed address, an over-cap address, a blocked user and an address
  of a user already added in the same request by email gives identical responses and statistically
  indistinguishable timing — and stays identical after the creator **removes** the seat, after the
  per-pair caps are hit with the same address, and when an invitation is claimed (no version
  bump or realtime event for other members); rows never joined show no name or id in any state;
  blocked pairs: never written as past opponents (04 invariant 6),
  only a creator↔`userId` block → `INVALID_INVITEES`, while a block between invitees (picked or
  typed) or with a member gives an `inert` seat and an identical response (Q3 parity), after a
  remove or decline every row shows only its state to the creator; claims apply the full block rule
  and the inbound cap atomically, never claim an `inert` row or a second row for the same user, and
  retry on a version change; the sweep claims seats for invitees who onboarded during creation;
  `add-player` with a block is a silent `204` no-op;
  lobby endings and lobby events other than auto-join and invitation send no push or email, the
  invitation push names nobody (T18); unsubscribe GET/POST e2e on both targets with the service worker active; onboarding:
  `403 ONBOARDING_REQUIRED` on game list, create, accept, join lookup and join until done, invites
  claimed only at onboarding completion, "I'm under `MIN_AGE`" deletes the account, the sweep
  deletes un-onboarded accounts after 7 days (never re-prompted ones), raising `MIN_AGE`
  re-prompts and gates the same endpoints, "I'm under" for a re-prompted user only signs out that
  session and deletes nothing (deletion still needs the step-up code); display-name rename limit; blocking a lobby co-member
  removes/leaves the seat; tunnel deployment: `TRUST_PROXY=cloudflare` with `TRUST_PROXY_PEERS`
  (foreign peer → `400`), the container health check passing without `CF-Connecting-IP`, no
  published ports; MIME builder tests with hostile display names (T14); `*_FILE` secrets.

## M5 — Paths game
- Requires the M4 child-safety items to be done.
- `@your-move/game-paths` package (02 §7), installed through `instance.config.ts`; the
  writing-a-game guide revised with anything learned.
- `paths` engine (games/paths.md): tile-set generator (35) and canonical ids, notch/rotation/edge
  maths, marker phase, movement, collisions, self-elimination rule, skipping empty hands, deck
  exhaustion + draw-order token, ranking.
- `paths` client module: responsive board, hand with rotate, ghost path preview, movement
  animation, two-step marker placement, colour-blind-safe markers, accessible names; original SVG
  art.
- **Accept:** passes the generic test kit at 2, 3, 5 and 8 players (CPU budget included, T25);
  module rule tables (games/paths.md §9); Playwright 4-player game via a join link on iPhone
  viewports down to 320 px wide.

## M6 — Bring-your-own dictionaries
- `BlobStore` (R2 / filesystem with key and path checks), `dictionaries` table, `serverOnly`
  distribution path, byte-sized LRU cache, resource authorisation for uploads.
- Upload pipeline (client-side normalise/sort/gzip, temporary key + streamed server validation +
  commit, removals applied), quotas (per-user incl. deleted-but-unpurged, instance-wide, account
  maturity), My word lists screen, picker integration, debounced server previews with per-word
  lookup limits, help page with official sources.
- Operator dictionaries through the Admin API (`POST`/`DELETE /api/v1/admin/dictionaries`) and the
  `pnpm admin:dict:add` / `admin:dict:delete` clients; admin email-suppression endpoints.
- **Accept:** a 280k-word list uploads and plays end-to-end on both targets; no route returns
  `serverOnly` contents, blob keys or hashes (route-wide test); using another user's or a deleted
  upload in a new game returns the same `400 INVALID_OPTIONS` (`detail.code = UNKNOWN_DICTIONARY`) as a nonexistent id; an off-rack
  play never yields `INVALID_WORDS`; zip-bomb and oversized uploads rejected while streaming;
  orphaned blobs swept; quota counts deleted-but-unpurged uploads; delete-while-in-use keeps
  existing games working and the sweep purges afterwards; upload CPU measured on Workers;
  the global removals (`removals-global.txt`, from the dictionary build's index) are applied to
  uploaded and operator lists, and each stored list's word count, alphabet, hash and size are
  recomputed from the cleaned text (M1b review S-2); validation streams with the 16 MB
  decompressed cap, stops early at the 500,000-word cap (`checkWordList`'s `maxWords`),
  short-circuits on an over-long line, and runs outside a Workers Free request if a request
  can't afford it (M1b review S-3).

## M7 — Accounts for children (pending Q20)
- Scope decided by Q20 (e.g. adult-managed profiles without email, device sign-in codes issued by the
  adult, restricted capabilities). Requires a privacy review first. (The minimum-age confirmation
  and parent-account guidance ship in M4.)

## M8 — AI players and MCP
- AI accounts (02 §9.2): create/rename/delete in Settings (daily limit, rename budget), tokens for
  them (`read` + `play` only, refused while the owner isn't onboarded), seating by the owner at
  creation, "<owner>'s AI" labels and badges everywhere, the hidden-information seating rule, no
  auto-start and invitations instead of auto-joins when AI is involved, owner-equivalence for
  blocks, limits.
- `@your-move/mcp` (02 §9.4): the local stdio MCP server over `@your-move/api-client`, with the
  untrusted-data wrapping of whole views and records, tool-description warnings (08 T28), token from
  a 0600 file or keychain, `https` only (except localhost), and refusal of tokens beyond `read` +
  `play`; published, with install instructions naming the registry explicitly.
- A short guide: connecting your own agent as an assistant or an opponent.
- **Accept:** **scripted** MCP-client tests in CI (no language model): the owner plays a complete
  `words` game against one of their own AI accounts, and a complete `paths` game with two of their
  own AI accounts, each AI seat driven through the MCP server; an AI account can't be invited,
  picked, link-joined or create a game; a human seat with `aiAssistance: "off"` refuses MCP
  submits; the MCP server refuses `admin` tokens and tokens with `games:create` or `join`;
  prompt-injection fixtures in display names, `describe` text and view fields reach the agent only
  inside the untrusted-data delimiters. Agents driven by a language model playing real games is a
  manual exploratory check the maintainers run from then on, not a CI gate.

## Later (ideas, not committed)

### Candidate game modules
Traditional games are public domain, so we can use their names; for trademarked games we use only
the generic mechanics, under our own name.

| Game | Players | Why it's a good fit | Framework features it exercises |
|---|---|---|---|
| **Go** (9×9 / 13×13 / 19×19) | 2 | Classic, deep, ideal for async play; small boards suit beginners and kids | Perfect information; pass-pass ending followed by a **dead-stone agreement phase** (`toAct` = both seats); superko check needs history; area scoring |
| Five in a row (gomoku) | 2 | Uses the Go board; very quick to learn | Smallest possible module, a good second reference |
| Reversi (generic Othello mechanics) | 2 | Simple and familiar | Forced passes |
| Draughts / checkers | 2 | Classic | Multi-jump turns (one action carrying a path) |
| Backgammon | 2 | Async classic with dice | Server dice on every turn (recorded rng); optional doubling cube = a mini agreement phase |
| Mancala family (oware, kalah) | 2 | Tiny rules, good for kids | Very small module |
| Nine men's morris | 2 | Traditional | Phase changes (placing → moving → flying) |
| Dots and boxes | 2–4 | Kids, pen-and-paper classic | Extra turns (same seat acts again) |
| Ludo / pachisi family | 2–4 | Kids, dice | Dice + capture; N players |
| Hearts, spades, euchre, cribbage | 3–4 (2 for cribbage) | Card-table classics for adults | Hidden hands; **simultaneous card passing**; teams; trick-taking |
| Yacht (generic Yahtzee-style dice) | 1–8 | Dice and scorecards; can be played side by side | Rerolls inside one turn |
| Battleships (generic) | 2 | Kids | **Simultaneous hidden setup** |
| Hex | 2 | Elegant, has no draws | Swap rule (pie rule) |

Go is the strongest next candidate: it's widely loved, has no IP issues, and its scoring agreement
phase is a good test of multi-seat `toAct`.

### Other
- Our own rulesets: different board shapes/sizes, tile distribution tweaks, new premium types,
  power-ups, timed "blitz" games, daily shared-rack puzzle.
- More dictionaries (permissively licensed English lists, other languages with their own rulesets'
  tile sets), and possibly per-game custom house-rule word lists.
- In-game chat (with block/report), 3–4 player word games, play vs. bot, word definitions (needs a
  permissively licensed dictionary source), stats, rematch button, spectators.

## First Workers deployment (unscheduled)

The proof of concept deploys to Docker (Q6), so no milestone above deploys to Cloudflare Workers;
the Worker build is still built and tested in CI. The milestone that first deploys to Workers adds
the CI deploy job (11 §9 stage 7, 09 §6): deploy `dist/worker` from the stage-3 artifact with
`--no-bundle`; wrangler from a lockfile-pinned, `--ignore-scripts` install carried as an artifact;
configuration generated from CI variables; no `pnpm install` in the job; `games:check-db` against
D1 first, as a self-contained bundle built in stage 3 and carried in the artifact. The D1- and
Workers-specific commands `pnpm cf:migrate` and `pnpm cf:deploy` arrive with it. It also
re-measures what one Cron Trigger invocation of the sweep spends (subrequests, D1 queries, CPU)
and sets the Worker's nudges-per-run cap from that (4 until then; 09 §3, alpha A6 review P-4).
