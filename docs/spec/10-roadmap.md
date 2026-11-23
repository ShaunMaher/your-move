# 10 — Roadmap

Each milestone goes through the agent loop in `CLAUDE.md`: **coder → picky reviewer → security
reviewer → coder fixes → owner sign-off**. A milestone is done only when its acceptance criteria
pass in CI.

## M0 — Skeleton
- pnpm monorepo per 03 §3, TypeScript strict, lint/format, Vitest, `.gitlab-ci.yml` running
  lint/typecheck/test.
- `apps/worker` and `apps/node` both serve a hello-world Hono app from `packages/server` and the
  Vite SPA shell.
- Config schema + `.env.example`.
- Shared security-header definition applied on Node and emitted as `_headers` for Cloudflare.
- **Accept:** `pnpm dev:node` and `pnpm dev:worker` (wrangler dev) both serve the SPA and
  `/api/health`; CI green; Docker image builds and runs; header test passes on both targets.

## M1 — Game SDK + words engine + dictionary
- `packages/sdk`: `GameDefinition` / `GameClientModule` types, recording `RandomSource`, `Resources`,
  and the generic test kit (02 §6: schema, replay, perturbation secrecy, termination, turn sanity,
  CPU budget).
- **A reference module** kept as a test fixture (e.g. a tiny hidden-hand card game) that exercises
  everything the word game doesn't: 2–4 players, a hidden hand, elimination, and one simultaneous
  secret phase (multi-seat `toAct`). It proves the contract and kit before the word game uses them,
  and drives the M3 framework tests.
- **Broken fixture modules** (02 §6) that the kit must reject.
- `words` ruleset schema, registry, behaviour variants (`swapOrder`), and the two MVP rulesets `classic` and
  `casual` (words §8.3) with original, symmetric premium layouts.
- Dictionary registry + build (per-dictionary `meta.json`, checksum, additions/removals, compact
  output, alphabet manifest), `DictionaryProvider`, lookup, and the ruleset↔dictionary compatibility
  check. MVP dictionary: `enable`.
- `words` engine as a `GameDefinition` (games/words.md §10): setup/deal, placement validation, word
  finding, scoring, swap/pass, resign/timeout, end conditions, final scoring, view, preview.
- **Accept:** the kit fails every broken fixture and passes the reference module at 2, 3 and 4
  players; words engine passes the generic test kit (including the CPU budget on `worstCase`
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
- OTP request/verify, sessions, display-name onboarding, logout/logout-all, `/me`, rate limiting,
  email providers (`console` + one real HTTP provider), security headers, Origin checks.
- Sign-in UI + welcome screen, PWA manifest/icons/service worker basics.
- **Accept:** integration tests for every 06 rule (expiry, attempts, 3-live-challenge behaviour,
  silent per-email drop creates no challenge, enumeration response *and* timing parity, rate limits
  incl. IP bucketing/XFF parsing, global caps); 50-parallel-verify race test on both drivers;
  logout-all test; Origin/JSON enforcement tests; `/__dev/emails` 404 in production config;
  zero CSP violations in Playwright; verified on a real iPhone home-screen install that sign-in
  persists across app restarts and that the home-screen label uses the runtime `APP_NAME`.

## M3 — Framework + play words
- Framework in `packages/server`: games registry, generic `games` / `game_players` /
  `game_actions` / `game_resources` / `past_opponents` storage, membership rules, lifecycle (lobby,
  auto-join vs invitation per `whoCanAddMe`, accept, remove seat, start with seat order, decline,
  leave, resign, cancel, lobby expiry), `toAct` sets and per-seat clocks, framework turn timeout
  with reminders and sweep, final views and summaries, stored `describe` text, option resolution,
  resource authorisation and loading, catalog/config/health endpoints, error table (05 §Errors).
- Game shell UI: new-game flow (game picker → module options form → players), game list across
  types, lobby screen, game frame (header, menu, history drawer, finished/ranking screen), lazy
  module loading.
- Words client module: board UI — drag & drop + tap-to-place, zoom, blank picker, live preview, shuffle/recall,
  swap/pass/resign dialogs.
- Realtime: `UserChannel` DO + Node hub; refetch on visibility.
- **Accept:** transition race tests (03 §5.2 list: exactly one wins and no partial writes, both
  drivers); framework tests run with both `words` and the reference module (proves no game-specific
  code leaked into the framework), covering with the reference module: start below max, decline in
  the lobby and before/after first action (ending `declined` vs resignation), leave, remove seat,
  cancel, lobby expiry, `validateStart` failure, per-seat timeouts in a multi-seat phase (one
  transition per seat, stops once the game ends), sweep idempotence, elimination shown as `out`;
  membership tests (users who left or were removed before start get `404`, `yourSeat` from the
  renumbered row); `whoCanAddMe` tests for all three settings; Playwright two-player full words game
  on WebKit iPhone viewport; route-wide secrecy test (04 invariant 4, incl. only the viewer's
  `final_views` entry); WebSocket upgrade Origin and session revocation tests;
  body-size/placement/socket-cap limits tested; p95 move latency measured.

## M4 — Invites, join links, notifications, polish
- Email invites (email-invite seats, claim on sign-in, lobby expiry, limits, suppression,
  unsubscribe routes per 05 §Email links).
- Inbound invitation cap with `suppressed` invitations.
- Join links (fragment tokens, create/rotate/revoke, landing page with explicit Join and
  `sessionStorage` return path, rate limits, block checks against every member, no re-entry after
  decline/leave/remove).
- Past opponents, blocks, sessions list, account deletion (resumable).
- **Before the path game (08 §5, Q20)**: `MIN_AGE` confirmation at onboarding, the
  "don't use your full name" warning, privacy page wording about children playing through a parent's
  account, and a copy review that nothing markets the service to children.
- Web Push (VAPID) + optional email nudges.
- Install guide banner, update toast, dark mode, accessibility pass.
- Docker compose example with Caddy, deploy docs, backup docs.
- **Accept:** push received on an installed iPhone; invite → signup → game appears; account
  deletion (with step-up code) leaves opponents' history intact and passes with `foreign_keys=ON`;
  push-endpoint allow-list tests (T12); unsubscribe token + RFC 8058 one-click tests (T17);
  `invite_email` cleared on terminal states and no raw address in `invites`; join-link token tests
  (T24), incl. that tokens never appear in server logs; inbound-cap test (T20); onboarding blocks
  game creation until the age confirmation is given.

## M5 — Paths game
- Requires the M4 child-safety items to be done.
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
- Operator dictionaries via `pnpm admin:dict:add`; `pnpm admin:dict:delete`.
- **Accept:** a 280k-word list uploads and plays end-to-end on both targets; no route returns
  `serverOnly` contents, blob keys or hashes (route-wide test); using another user's or a deleted
  upload in a new game returns the same `400 UNKNOWN_DICTIONARY` as a nonexistent id; an off-rack
  play never yields `INVALID_WORDS`; zip-bomb and oversized uploads rejected while streaming;
  orphaned blobs swept; quota counts deleted-but-unpurged uploads; delete-while-in-use keeps
  existing games working and the sweep purges afterwards; upload CPU measured on Workers.

## M7 — Accounts for children (pending Q20)
- Scope decided by Q20 (e.g. adult-managed profiles without email, device sign-in codes issued by the
  adult, restricted capabilities). Requires a privacy review first. (The minimum-age confirmation
  and parent-account guidance ship in M4.)

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
