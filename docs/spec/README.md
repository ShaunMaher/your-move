# Specification

Status: **DRAFT v0.9.17** (v0.2 revised after picky + security review; v0.3 adds selectable rulesets and dictionaries; v0.4 adds bring-your-own dictionaries; v0.5 turns the product into a multi-game framework, 2026-11-21; v0.6 applies the v0.5 picky + security review — contract hooks, framework-owned timeouts and seat order, invitations and `whoCanAddMe`, join-link hardening, upload quotas, minimum age, paths geometry — 2026-11-23, traceability in `docs/reviews/spec-v0.5.md`; project named **Your Move**, 2026-11-23; v0.7 applies the v0.6 re-review — history endpoint, framework-only `declined` ending, no auto-start with join links, dictionary config moved to the framework, onboarding gate and under-age exit, hidden invitations — plus owner decisions Q2 (Workspace email) and Q3 (never reveal whether an address has an account), 2026-11-23, traceability in `docs/reviews/spec-v0.6.md`; v0.8 applies the v0.7 final review — Q3 gaps closed (names of never-joined rows, per-pair limits by `emailId`, literal duplicates only, invisible claims), blocks never recreate past opponents, Gmail via a `gmail.send`-only OAuth token, decline wording, `checkConfig`, tunnel hardening, 2026-11-23, traceability in `docs/reviews/spec-v0.7.md`; v0.8.1 applies the v0.8 focused verification, 2026-11-23, same record; v0.9 adds games as packages from other repositories composed at build time, API first with a versioned `/api/v1` and an Admin API, API tokens, AI accounts, AI assistance and an MCP server, and the engineering standards (11) that M0 delivers, 2026-11-23; v0.9.1 applies the v0.9 picky + security review — narrower token scopes and admin tokens only, release and Renovate secrets confined to protected environments with no automerge, orphan checks at deploy and run time, the SDK's package contract and 0.x until M4, AI seats always visible and never auto-started, honest trust model for installed games, 2026-11-23, traceability in `docs/reviews/spec-v0.9.md`; v0.9.2 applies the focused verification of v0.9.1 — deploy jobs never load game code (`installed.json`), deny-by-default scope test over the real router, e2e on the Node build, GitLab CE confinement without protected environments, 2026-11-23; v0.9.3 aligns the spec with the M0 implementation review — kaniko (or rootless BuildKit), pnpm installed through `mise.lock`, `allowBuilds`, the Prettier exclusions, `GET /api/v1/config` in M0, the extra config rules, `scripts/`/`tests/`/`config/` in the layout, the Workers deploy job deferred to the first Workers deployment, error logging without input-derived messages, the Playwright-image Node exception, the M0 dependency-rule wording (10), SBOMs and image provenance labels in the pipeline (11 §9), and the M1 job-token check and release notes, plus Q25 resolved (the `your-move` npm organisation is claimed), 2026-11-23, traceability in `docs/reviews/m0.md`; v0.9.4 applies the M0 round-2 review — rejected requests keep only the statuses 05 maps to one code, the full Node image in CI, SBOMs of every shipped production closure as pipeline artifacts, release notes and digests from M1, the Workers deploy job's bundled `games:check-db`, the toolchain pin check, nested `package.json`/`node_modules`/CommonJS refused in game packages and the M1 bundler-input check, 2026-11-23, same record; v0.9.5 applies the M0 round-3 review — parse errors logged without their message (05 §Errors), 2026-11-23, same record; v0.9.6 records that CI runners need x86-64-v2 (SSE4.2) on amd64 for workerd, with the Worker contract tests on the arm64 runner until the amd64 runner offers it, and per-architecture caches (11 §9), 2026-11-23, same record; v0.9.7 pushes images with a Maintainer-role, registry-only project access token, because protected container repositories refuse deploy tokens; packages keep the deploy token; deletion through the protected container repositories needs Owner, and M1 gives the two publish jobs separate environment scopes (08 §6, 09 §6, 11 §9, 10 M0/M1, findings.md F-8, F-9), 2026-11-23; v0.9.8 records what M1a settled — records never depend on information hidden before their transition (02 §2.1 rule 5), `HistoryItem` receives the stored `describe` text (02 §3), workspace game packages are built before they are checked and checked as far as `pnpm pack` publishes them, the bundler-input closure check `pnpm games:check-inputs` (02 §7.3), parse errors as an explicit exception to logging the message (05 §Errors), the SDK ↔ api-client type-level test in M3 and the testkit's peer-dependent bump in M1's release path (10), 2026-11-23; the M1a review then added the kit's test hooks (`test.optionInputs`, required, with optional `test.context` and `test.resources`, played by `games:verify`), secrecy samples spread over each game, the secret-choice record check, key order kept in comparisons, view-based non-vacuity, games without exits, non-vacuous `worstCase` and the actual kit counts (02 §2, §2.1, §6), the per-role bundler-input closure (02 §7.3, 11 §9), the CPU budget measured on the kit's host with an override (08 T25), and `[max, value]` draws in M3 (10), 2026-11-24, and its round 2 the declared `test.hiddenFromEveryone` for state-based non-vacuity, eight grouped actions per sample for the secret-choice check with `randomAction` covering every action kind, worst cases of their own seat count (02 §2, §6) and the stricter engine lint (F-5), 2026-11-24, traceability in `docs/reviews/m1a.md`; v0.9.9 records what M1b part 1 settled — rulesets are TypeScript data modules under `games/words/src/engine/rulesets/` parsed when the engine loads, the extra ruleset checks, the edit-file format, the dictionary build output and manifest, the global removals also applied to built-in lists (words §8.1, §8.2, §9.1) and the lookup and startup measurements (03 §10), 2026-11-24; the M1b part 1 review then added no two premium squares side by side and casual's counts (words §8.2, §8.3), `wordsSha256` checked once per load, the global removals in the build's index, the per-source removals rule and the tied board and word-length caps (words §9.1, 03 §10), the `loadText` contract (10 M3) and the upload removals and streaming-validation criteria (10 M6), and round 2 the limits on word multipliers in short words (words §8.2), traceability in `docs/reviews/m1b-1.md`; v0.9.10 records what M1b part 2 settled — the words engine's state shape, the full check order, the extra error codes and details (`NOT_TO_ACT`, `OPTIONS_NOT_OBJECT`, `UNKNOWN_OPTION`, the swap and `checkConfig` details), `lastMove` and sorted racks in the view, the `decline` record and ending, the derived `maxActions` bound, the worst cases and the kit word list carried in the engine (words §10.2–§10.6), and its review round 1: two seats only until §3.4 specifies more, a discriminated `WordsRecord`, placements in board order, the `NOT_ENOUGH_TILES` and `UNKNOWN_OPTION` details, the 15-letter worst case, `describe` naming a single tile's longest word, the `test` hooks never read by framework or runtime code (02 §6, findings F-11) and three M3 items (the installed dictionaries in `games:verify`, `has()` on 15-letter words, a view-level play analysis), then the calibrated CI CPU budget for the kit (`KIT_CPU_BUDGET_MS`, 02 §6, 08 T25), 2026-11-24, traceability in `docs/reviews/m1b-2.md`; v0.9.11 gives slow test infrastructure deliberate, measured time budgets instead of retries, with a browser's launch and first page each budgeted apart from the per-test timeout (11 §4, ADR 0004, issue #7), 2026-11-24; v0.9.12 makes the words board layouts fair to the first player (issue #10) — a word through the start square of up to `rackSize` letters covers at most the start square's own word multiplier and never more than ×2, the cap on word multipliers is ×4 for every word of up to 7 letters, and both MVP layouts are redesigned in place to meet them, with their no-mirror and `X.X` limits stated (words §8.2, §8.3), 2026-11-24, traceability in `docs/reviews/m1b-1.md`; v0.9.13 records what M2a settled — Node's built-in `node:sqlite` instead of better-sqlite3, through Drizzle's `sqlite-proxy` driver, with the repositories written once in the core and the contract suite on both drivers (03 §2, §4, §5.2, 04, 08 §6), migrations tracked by hash, run with foreign keys off on Node, and checked in CI (regenerated unchanged, a consistent journal, no unreviewed table rebuild, which cascades on D1) (04 §Migrations), the single-instance lock (03 §5.3), startup validating the configuration before touching the database and `ALLOW_ORPHAN_GAMES` bound to one orphan set (02 §7.3, 09 §1, §4), and HKDF's empty salt (09 §1.1), 2026-11-24, traceability in `docs/reviews/m2a.md`; v0.9.14 applies the M2a round 2 migration-safety items (issue #13) — no transaction control in a migration, refused by `pnpm db:check` and by Node, the rebuild rule matched with comments removed and whitespace collapsed and catching qualified or quoted pragmas, `pnpm db:check` comparing the schema the committed migrations build with a fresh generation from `schema.ts`, `REPLACE INTO` and parent `DELETE` cascading, migrations never relying on `ON DELETE` actions, and `foreign_key_check` only with migrations pending and an existing violation reported as such (04 §Migrations), and a startup warning while the database directory is open to group or others (09 §1), 2026-11-25, same record; v0.9.17 records what alpha slice A3 (the words board UI) settled — swap and pass are the board's own dialogs and resign stays the shell's menu, word validity comes from the shell's `preview` with the score shown at once from the engine's view-level analysis (07 §2, §3), and a client module installs its CSS as a constructable stylesheet because the CSP allows no inline styles (02 §3), 2026-11-25). M0 (the skeleton and engineering standards) is implemented (MR !3, review record `docs/reviews/m0.md`). These documents are the source of truth for
the coding agent; if code and spec disagree, the spec wins until the spec is changed on purpose.

The project is called **Your Move**. The name is still never hard-coded: everywhere it would
appear, use the configured value `APP_NAME` (default `Your Move`, see
[09-operations.md](09-operations.md)), so forks and self-hosted instances can rebrand without code
changes. This applies to code, copy, emails, manifests and Docker image names. Package names
(`@your-move/*`) are the project's identity rather than branding and stay as they are in a fork.

| # | Document | What it covers |
|---|----------|----------------|
| 01 | [Product](01-product.md) | Goals, users, scope, non-goals, user stories |
| 02 | [Game framework](02-game-framework.md) | Game module contract, lifecycle (lobby, seats, turns, timeouts), secrecy, replay, test kit, game packages, AI players |
| G1 | [Game: words](games/words.md) | Crossword-tile word game: rules, rulesets, dictionaries, module contract |
| G2 | [Game: paths](games/paths.md) | Path-laying tile game for 2–8 players |
| 03 | [Architecture](03-architecture.md) | Repo layout, runtimes (Cloudflare + Docker), storage, realtime, Durable Objects |
| 04 | [Data model](04-data-model.md) | Tables, columns, invariants |
| 05 | [API](05-api.md) | Versioned public HTTP + WebSocket API, OpenAPI, tokens, Admin API |
| 06 | [Auth & accounts](06-auth.md) | Email OTP, sessions, display names, invites, step-up, API tokens, AI accounts |
| 07 | [Frontend & PWA](07-frontend.md) | React app, mobile layout, interaction, PWA/iOS specifics |
| 08 | [Security](08-security.md) | Threat model and required controls |
| 09 | [Operations](09-operations.md) | Configuration, email delivery, deploy targets, observability |
| 10 | [Roadmap](10-roadmap.md) | Milestones and acceptance criteria |
| 11 | [Engineering standards](11-engineering.md) | Toolchain, TypeScript, lint, tests, architecture rules, hygiene, releases, Renovate, CI, ADRs |
| -- | [Open questions](open-questions.md) | Decisions we still need from the owner |

## Conventions used in these docs

- **MUST / SHOULD / MAY** carry RFC 2119 meaning.
- "Server" means the shared application core, regardless of runtime (Worker or Node).
- "Runtime adapter" means the thin per-platform layer (Cloudflare or Node) that plugs storage,
  realtime, email and secrets into the shared core.

## Glossary

Framework terms:

| Term | Meaning |
|------|---------|
| Game module | A self-contained game (rules engine + board UI) plugged into the framework (02). |
| Game package | An npm package that ships a game module through three entry points: `/engine`, `/client`, `/manifest` (02 §7.1). |
| Manifest | A game package's metadata: type id, name, icon, rules text, licence, resource kinds, hidden information (02 §7.2). SDK compatibility is the package's SDK peer range. |
| SDK | `@your-move/sdk`, the versioned contract between the framework and every game package; `@your-move/testkit` holds the generic test kit (02 §6, §7.4). |
| Instance config | `instance.config.ts`: the game packages an instance installs; composed at build time (02 §7.3). |
| API token | A personal, scoped (`read`, `play`, `games:create`, `join`; or an exclusive, short-lived `admin`), expiring credential (`ym_pat_…`) for the public API (06 §8, 05 §Token scopes). |
| Orphaned game | A `lobby`/`active` game whose game type or rules version is no longer installed; writes get `409 GAME_UNAVAILABLE` and the sweep cancels it (02 §7.3). |
| Step-up code | A one-time code sent for one specific sensitive action (`delete_account`, `token_create`, `token_admin`), separate from sign-in (06 §7). |
| AI account | An account of kind `agent`, owned by a person, with no email, acting only through tokens and always labelled AI (02 §9.2). |
| AI assistance | The per-game setting that decides whether people's own agents may make moves on human seats (02 §9.3). |
| AI move | A move submitted with an API token (`via = token`), shown as AI or AI-assisted in history (02 §9.1). |
| MCP server | `@your-move/mcp`, a local Model Context Protocol server that lets a person's agent use the API (02 §9.4). |
| Admin | A user listed in `ADMIN_EMAILS`, able to use the Admin API with a step-up code or an `admin` token (05 §Admin API). |
| Step-up | A fresh, purpose-bound email code proving the account holder is present (06 §7). |
| Game shell | The framework UI around every game: list, new-game flow, lobby, header, menu, history (02 §3). |
| Seat | A player position in a started game, numbered from 0; seat order is turn order (02 §4). |
| Seat order | The creator's choice of turn order: `join` (creator first, then in joining order) or `random` (a recorded draw at start) (02 §4). |
| Lobby | A created game waiting for seats to fill before it starts (02 §4). |
| Open seat | A lobby seat not held by an `invited` or `joined` row; join links fill open seats (02 §4). |
| Invitation | A lobby seat offered to an existing user, who must accept it: anyone added by email, or a past opponent whose `whoCanAddMe` is `nobody` (02 §4, 06 §6.2). |
| Email-invite seat | A lobby seat for an address with no (onboarded) account; the person gets an invite email and the seat is **claimed** when they complete onboarding with that address (06 §6.3–6.4). |
| Delivery | How an invitation reaches its target: `normal`, `hidden` (over the inbound cap; only in the collapsed *Hidden invitations* list) or `inert` (blocked pair; never delivered). All look the same to the creator (04, 06 §6.7). |
| `whoCanAddMe` | A user's setting: `pastOpponents` (default; past opponents picked from the list auto-join you) or `nobody` (everything is an invitation) (06 §6.2). |
| Join link | A shareable link that lets signed-in people take open lobby seats; a game with one waits for the creator's Start (06 §6.8). |
| Past opponent | A user you've finished a game with, both having acted; link joiners only with the creator's confirmation (06 §6.9). Can add you directly under the default setting. |
| Onboarding | Setting a display name and confirming `MIN_AGE` after first sign-in; until done the account is invisible to others (06 §5). |
| Invite claim | Turning an email-invite seat into an invitation when someone with that address completes onboarding (or the sweep finds one); a row-level update invisible to other members (02 §4, 06 §6.4). |
| Re-prompt | Asking an onboarded user to confirm their age again after the operator raises `MIN_AGE`; their account stays, but the gated endpoints answer `403 ONBOARDING_REQUIRED` until they do (06 §5). |
| Decline (after start) | A seat leaving before its first action: no loss, no rank; recorded as "declined", never "resigned" (02 §2.1 rule 9, §4). |
| Exit reason | The `reason` passed to `onResign`: `resign` or `decline` (02 §2.1 rule 9). |
| Resource catalog | Metadata (never contents) of the resources a creator may use, or, for `checkConfig`, of every enabled built-in and operator resource (02 §2). |
| Turn timeout / deadline | The creator's per-game limit (1–30 days) for a seat to act once it's in `toAct`; the deadline is when that seat's clock runs out (02 §4). |
| Action | One move submitted by a player, defined by the game module. |
| `toAct` | The set of seats that may act now (02 §2.3). |
| Phase | A stretch of a game where several seats in `toAct` each act once, in any order (02 §2.3). |
| View | What one seat (or the public) may see of a game's state; the only way state reaches a client (02 §2). |
| Public record | A module's description of one transition, visible to every seat; used for history and notifications (02 §2.1). |
| `Text` / `describe` | Display text made of strings and `{ seat }` placeholders, filled with current names when shown; `describe` turns a public record into `Text`, stored with each log entry (02 §5). |
| Final views | Each seat's (and the public) last `view` and `summary`, stored when a started game ends; finished games display from them (02 §5). |
| Resource | External data a module needs, loaded and authorised by the framework, e.g. a dictionary (02 §2.1). |
| Out / eliminated | A seat no longer playing: eliminated by the rules, resigned, timed out, or declined before a first action (never ranked) (02 §4). |
| `endReason` | Module-defined reason a game ended, or a framework reason (`declined`, `cancelled`, `expired`). |
| OTP | One-time password emailed to the user for sign-in. |

Word game terms (games/words.md):

| Term | Meaning |
|------|---------|
| Ruleset | A versioned data file describing board, premium squares, tiles, rack size, bonuses and behaviour variants; chosen per game (words §8). |
| Dictionary | A versioned word list with metadata (language, licence); chosen per game; a framework resource (words §9). |
| Distribution | `public` (clients may download the list, e.g. ENABLE) or `serverOnly` (the list never leaves the server) (words §9.5). |
| Operator / uploaded dictionary | A `serverOnly` list added by the instance operator for everyone, or uploaded by a player for games they create (words §9.5). |
| Rack | The tiles a player currently holds (default 7). |
| Bag | Undrawn tiles. Its order is server-secret. |
| Bingo | Placing `rackSize` (default 7) tiles in a single play. Emptying a smaller late-game rack is not a bingo. |

Path game terms (games/paths.md):

| Term | Meaning |
|------|---------|
| Deck | Undrawn tiles; its order is server-secret. |
| Hand | The tiles a player holds (default 3), hidden from others. |
| Marker | A player's piece, sitting on a notch and facing an empty square. |
| Notch | One of 8 path endpoints on each square's edges, numbered 0–7 clockwise (paths §1). |
| Edge notch | A notch on the outer edge of the board, numbered `0..8·boardSize−1` clockwise; markers start on one (paths §1). |
| Tile id | A tile's stable number 0–34 from the canonical ordering of the 35 generated tiles (paths §1). |
| Draw-order token | Marks who is dealt first when tiles return to an exhausted deck (paths §4). |
