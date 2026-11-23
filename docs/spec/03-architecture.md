# 03 — Architecture

## 1. Principles

1. **One core, two thin runtimes.** All business logic lives in runtime-agnostic TypeScript that
   uses only Web-standard APIs (`fetch`, `Request`/`Response`, WebCrypto, `TextEncoder`, streams).
   Cloudflare- and Node-specific code lives only in the two runtime adapters.
2. **Pure game engine.** Rules, validation and scoring are pure functions with no I/O, shared by
   server (authoritative) and client (previews).
3. **SQL is the source of truth** on both targets. Cloudflare D1 and SQLite are the same dialect,
   so one schema and one migration set serve both.
4. **Server-authoritative, hidden-information safe.** The client never receives secret state.
5. **Boring, small dependency set.** Each dependency must justify itself (supply-chain risk).

## 2. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict), ES2022 modules | Shared types across engine/server/client |
| Package manager | pnpm workspaces | Fast, strict, good monorepo support |
| HTTP framework | [Hono](https://hono.dev) | Runs natively on Workers and Node; tiny; typed routes |
| Validation | Zod (or Valibot if bundle size matters) | Shared request/response schemas, used client-side too |
| DB access | Drizzle ORM + drizzle-kit migrations | First-class D1 *and* better-sqlite3 drivers, same schema |
| Node SQLite driver | better-sqlite3, WAL mode | Mature, synchronous, fast |
| Node WebSockets | `ws` (via `@hono/node-ws` or direct) | Standard |
| Frontend | React 18+, Vite, React Router | As requested; Vite has the best PWA tooling |
| PWA | `vite-plugin-pwa` (Workbox) | Manifest + service worker generation |
| Client state | TanStack Query for server state; small local store (Zustand or `useReducer`) for board drag state | Keep it simple |
| Styling | CSS modules or plain CSS with custom properties | No heavy UI kit; we need full control of the board |
| Tests | Vitest (unit + integration), Playwright (e2e, mobile viewports) | Same test runner across packages |
| Lint/format | ESLint + Prettier (or Biome) | Pick one in M0 |

## 3. Repository layout

```
/
├─ apps/
│  ├─ web/                 React PWA (Vite)
│  ├─ worker/              Cloudflare entry: Worker fetch handler, Durable Object classes,
│  │                       cron handler, wrangler.toml (template), D1 binding
│  └─ node/                Node entry: HTTP server, ws hub, SQLite, interval scheduler,
│                          Dockerfile, docker-compose.example.yml
├─ packages/
│  ├─ sdk/                 GameDefinition + GameClientModule types, RandomSource, Resources,
│  │                       and the generic test kit (02 §2, §3, §6). No runtime deps.
│  ├─ games-registry/      Server-side registry of game engines + versions (02 §7)
│  ├─ dictionary/          dictionaries/<id>/ (source, meta, additions/removals), build script,
│  │                       lookup API (a resource provider used by `words`)
│  ├─ shared/              Zod schemas and TS types for the API + WebSocket protocol
│  └─ server/              Runtime-agnostic Hono app: framework (lifecycle, transitions, lobby,
│                          timeouts), accounts, routes, repositories, rate limiting, email
│                          templates. Depends on a `Platform`. Knows games only via the registry.
├─ games/
│  ├─ words/
│  │  ├─ engine/           Pure GameDefinition + rulesets/<id>/v<N>.json   (@app/game-words)
│  │  └─ client/           React GameClientModule                          (@app/game-words-client)
│  └─ paths/
│     ├─ engine/           (@app/game-paths)
│     └─ client/           (@app/game-paths-client)
├─ docs/spec/              This specification
├─ .claude/agents/         Agent definitions (coder, picky reviewer, security reviewer)
└─ LICENSE (BSD-2-Clause)
```

Package scope: `@app/*`. It stays generic even though the project is named, so a rebranded fork
needn't rename packages.

## 4. The `Platform` port

`packages/server` exports `createApp(platform: Platform): Hono`. Each runtime builds a `Platform`:

```ts
interface Platform {
  repos: Repositories;             // async repository interfaces (see below) — NOT a Drizzle type
  realtime: RealtimePublisher;     // publish(userIds, event) + revokeSession(userId, sessionId)
  email: EmailSender;              // send(msg: { to, subject, text, html }): Promise<void>
  push: PushSender;                // Web Push (VAPID), implemented once with WebCrypto in core
  blobs: BlobStore;                // get/put/delete by key, streaming: R2 on Cloudflare, /data/blobs on Node (words §9.5)
  config: AppConfig;               // validated env (APP_NAME, PUBLIC_URL, secrets...) — see 09
  now(): Date;                     // injectable clock for tests
  log: Logger;                     // structured JSON logs, never logs secrets/OTPs
  waitUntil(p: Promise<unknown>): void; // background work after response (CF ctx.waitUntil / Node: fire-and-track)
}
```

**Database boundary.** Drizzle's D1 driver is async and supports `batch()` but not interactive
transactions; the better-sqlite3 driver is synchronous and supports `transaction()` but not
`batch()`. So core code never touches a Drizzle database object. Instead:

- `packages/server/src/db/schema.ts` holds the one shared Drizzle schema.
- Core depends on async repository interfaces (`UserRepo`, `SessionRepo`, `OtpRepo`, `GameRepo`,
  `RateLimitRepo`, …) whose methods express whole operations, e.g.
  `GameRepo.applyTransition(gameId, expectedVersion, writeSet): Promise<"ok" | "stale">`.
- Shared query-building code lives in `packages/server/src/db/queries/*` and produces Drizzle query
  objects; each adapter executes them: D1 → `db.batch([...])`, Node → inside a synchronous
  `sqlite.transaction(() => ...)`.
- A shared repository contract test suite runs against **both** adapters (Node in-process; D1 via
  Miniflare / `@cloudflare/vitest-pool-workers`).

**Randomness.** Production randomness always comes from WebCrypto (`crypto.getRandomValues`,
`crypto.randomUUID`). The engine receives it as an explicit `RandomSource` argument (02 §2); the
server constructs the WebCrypto-backed source in exactly one place. Only tests construct seeded
sources.

## 5. Storage

### 5.1 Is a Durable Object suitable?

**Yes — but as the coordinator, not the only database.** Recommended split on Cloudflare:

| Data | Where | Reason |
|---|---|---|
| Users, sessions, OTPs, invites, games index, game state, moves, push subscriptions, rate-limit buckets | **D1** (SQLite) | Needs cross-entity queries ("my games", "find user by email"); same schema as Docker's SQLite file |
| Live connections / fan-out | **Durable Object per user** (`UserChannel`) using the WebSocket Hibernation API | DOs are the only Cloudflare primitive that can hold WebSockets and address one logical entity globally; hibernation means idle sockets cost ~nothing |

Why not keep each game's state *only* in a per-game DO's storage? It works well on Cloudflare
(single-threaded per game = free serialisation), but (a) we'd still need D1 for user lookup and
game lists, creating two sources of truth to keep in sync, and (b) the Docker target would need a
completely different storage path. Instead we get serialisation from SQL itself (§5.2), which
behaves identically on both targets.

Revisit if contention or latency becomes a problem: moving authoritative game state into a
per-game DO (with D1 as an index) is a contained change behind the `GameRepository` interface.

### 5.2 Game state transitions (actions and everything else)

Every `games` row has an integer `version` and a `write_token`. **Every** state change to a game —
action, join, accept, remove, start, resign, decline, leave, cancel, invite claim, expiry, timeout
(02 §4) — is a *transition* applied like this:

1. Load game state + version.
2. Compute the new state with the game module (pure), with recorded randomness and pre-loaded
   resources (02 §2).
3. Generate a fresh random `writeToken` (UUID). Execute atomically (D1 `batch()` / SQLite
   transaction):
   1. `UPDATE games SET <new state>, version = version + 1, write_token = :writeToken
      WHERE id = :id AND version = :expectedVersion`
   2. every dependent write (insert `game_actions` row, update `game_players` to_act/state/rank, …) is guarded
      so it only takes effect if *this* transition won:
      `INSERT INTO game_actions (...) SELECT ... WHERE (SELECT write_token FROM games WHERE id = :id) = :writeToken`
      `UPDATE game_players SET ... WHERE game_id = :id AND seat = ? AND (SELECT write_token FROM games WHERE id = :id) = :writeToken`
4. Success is determined by statement 1's affected-row count (D1 `meta.changes`). If 0 → `stale`:
   no guarded statement could have matched, because the losing writer's token was never stored.
   Return `409 STALE_GAME`; the client refetches.

Why a token and not a version guard: guarding on `version = expected` would skip the winner's own
dependent writes (its UPDATE already bumped the version), and guarding on `version = expected + 1`
would let the loser's dependent writes through after the winner bumped it. A per-write token can
only match the writer that set it.

Belt and braces: `PRIMARY KEY(game_id, seq)` on `game_actions` makes a duplicate action a constraint error
that aborts the whole batch/transaction.

On Node the same statements run inside one synchronous `better-sqlite3` transaction (where
`changes === 0` on statement 1 simply rolls back), but they are generated by the same shared query
code so behaviour is identical.

Required tests (M3/M4): two concurrent moves at the same version → exactly one succeeds and the
database matches the winner's state exactly, on both drivers; same for move-vs-decline,
**sweep timeout vs a last-second move**, start-vs-cancel, accept-vs-remove, accept-vs-cancel,
remove-vs-join, claim-vs-cancel, a claim or accept that triggers an automatic start, and
join-vs-join for the last open seat.

Clients send `expectedVersion` with every client-initiated transition, which doubles as
double-submit protection. Transitions the server starts itself (join, invite claim, sweep, account
deletion) reload and retry up to 3 times on `stale`; if the transition no longer applies after a
reload (e.g. the seat filled), the caller gets the outcome for the new state (e.g. the join link's
indistinguishable `404`).

### 5.3 Docker storage

Single SQLite file on a mounted volume (`/data/app.sqlite`), WAL mode, `busy_timeout` set,
`foreign_keys=ON`. Backups: documented `sqlite3 .backup` / Litestream recipe in 09.
The Node runtime is **single-instance** by design; running two containers against one file is
unsupported and the app SHOULD refuse to start if it detects another live instance (lock file).

## 6. Realtime

- Client opens one WebSocket per signed-in app instance: `GET /api/ws` (cookie-authenticated,
  Origin-checked, per-IP upgrade rate limit — see 08). The target channel is always the
  **session-derived** `userId`; nothing client-supplied selects the channel.
- Server publishes small *invalidation* events, not full state:
  `{ type: "game.updated", gameId, version }`, `{ type: "game.created", gameId }`,
  `{ type: "games.changed" }`. Clients refetch via HTTP. This keeps secrets out of the socket
  path entirely and makes reconnect logic trivial.
- **Keep-alive is client-driven**: the client sends `"ping"` every 30 s and the server answers
  `"pong"`. On Cloudflare this uses `state.setWebSocketAutoResponse()` so pings never wake a
  hibernated DO. The server never initiates pings.
- **Cloudflare:** the Worker authenticates the upgrade, then forwards it to the `UserChannel` DO
  (`idFromName(userId)`), which accepts with `state.acceptWebSocket(ws, [sessionId])`
  (hibernation; socket tagged with its session). Publishing = RPC/`fetch` to each recipient's DO via
  `waitUntil`. Revoking a session = RPC to the DO, which closes `getWebSockets(sessionId)`.
- **Node:** in-process `Map<userId, Set<{ ws, sessionId }>>`; `ws` configured with
  `maxPayload: 1024`.
- Sockets have a maximum lifetime of 24 h, after which the server closes them (code 4000) and the
  client reconnects, re-authenticating its session.
- WebSocket is an enhancement: the client also refetches on `visibilitychange` → visible, on focus,
  and on reconnect. The app MUST be fully usable with WebSockets blocked.

## 7. Notifications

- **Web Push** (VAPID) to subscribed devices when it becomes a user's turn, a past opponent adds
  them to a new game (auto-join), or a game that reached `active` ends. A new invitation (not
  `hidden` or `inert`) sends only the generic "You have a new game invitation" push, at most one per
  recipient per day (06 §6.2). Lobby endings (`cancelled`,
  `expired`, `declined` from the lobby, including cancels caused by account deletion) send realtime
  invalidations only — no push, no email. iOS supports this only for home-screen web apps (16.4+) and only
  after a user gesture grants permission — the UI asks after the first game is created, not at
  sign-in.
- Push text is built only from public `describe` text (02 §5) and display names, never from state
  (e.g. "Alex played QUIZ for 64. Your turn."). Invitations and lobby join/leave/remove events
  never send pushes (06 §6.2).
- Implemented once in `packages/server` using WebCrypto (RFC 8291 aes128gcm + RFC 8292 VAPID) or a
  vetted Workers-compatible library; must work on both runtimes.
- Optional email nudge (default off, per-user setting): "It's your turn" after 24 h idle, max one
  per game per day; and at most one email per normal invitation, sent when it's created or claimed
  (06 §6.2), not by the sweep.

## 8. Scheduled work

(Turn timeouts are applied here and nowhere else; GET handlers never write game state.)

One `sweep()` function in core, invoked by Cloudflare Cron Triggers (`*/15 * * * *`) or a Node
`setInterval`. Every step is idempotent and uses the same transition mechanism as actions:

- Expire OTPs, sessions, invites, join links and rate-limit buckets.
- Delete accounts that haven't completed onboarding 7 days after creation (06 §5).
- Apply per-seat turn timeouts via module `onTimeout`: overdue seats one transition at a time, in
  seat order, reloading and re-checking `toAct` and the deadline before each (02 §4).
- Send timeout reminders (50 % and 24 h before, 02 §4; tracked in `timeout_reminders_sent`, which
  every clock restart resets to 0).
- Expire lobbies 14 days after creation.
- Send due email nudges.
- Purge blobs of deleted dictionaries no `lobby`/`active` game references (`game_resources`), and
  delete row-less upload blobs older than 1 h (words §9.5).
- Resume unfinished account deletions (04 §Account deletion).

## 9. Static assets and routing

- Server-handled paths: `/api/*` (including the server-rendered unsubscribe page,
  `/api/email/unsubscribe`, 05 §Email links), `/manifest.webmanifest` (generated at runtime from
  config so a prebuilt image/bundle carries no name — 07 §4), and `/__dev/*` (returns 404 unless
  local-dev mode, 06 §4). Everything else → built SPA from `apps/web/dist` with SPA fallback to
  `index.html`. An M4 e2e test GETs and POSTs the unsubscribe URL on both targets with the service
  worker active.
- `index.html` contains no product name; the SPA sets `document.title` and the
  `apple-mobile-web-app-title` meta at startup from `/api/config` (verify the iOS home-screen label
  on a real device in M2; if iOS ignores the runtime values, serve `index.html` through the server
  with the name injected).
- **Cloudflare:** Workers Static Assets with `not_found_handling = "single-page-application"` and
  `run_worker_first = ["/api/*", "/manifest.webmanifest", "/__dev/*"]`. Because static responses
  bypass the Worker, the web build emits a **`_headers` file** carrying the security headers (08 §3)
  and cache rules for all static paths. It is generated at build time; if Turnstile is enabled the
  build must be run with `TURNSTILE_ENABLED=true` so the CSP includes its origin.
- **Node:** Hono `serveStatic` plus a middleware that applies the same header set (shared constant
  in `packages/server`, also used to generate `_headers`, so the two can't drift).
- Cache: long-lived immutable for hashed assets; `no-cache` for `index.html`, `sw.js`,
  `manifest.webmanifest`.
- Same origin for app and API on both targets (no CORS needed; CORS stays disabled).

## 10. Dictionary at runtime

- Server: a `DictionaryProvider` loads dictionaries lazily by id and caches them per
  isolate/process. Each compact sorted word list is either bundled into the Worker / Node build as a
  text module or, on Cloudflare once the total exceeds the bundle budget, fetched once per isolate
  from the static-assets binding (Node reads it from disk). Lookup is a binary search directly over
  the text (no parse), or any index is built outside request handling, never inside a request.
  Memory < 25 MB per loaded dictionary. Measure Worker startup time and per-lookup CPU in M1 and
  record the numbers.
- `serverOnly` dictionaries (operator and uploaded, words §9.5) are loaded from `BlobStore` on first
  use into an in-memory LRU cache **sized by bytes** (default 60 MB per isolate or process, below the
  Worker's 128 MB limit). Lookup is a binary search over the raw sorted text with no index build,
  so a cache miss costs only I/O. Each user may cause at most a few distinct `serverOnly` loads per
  hour (08 §4), so rotating lists can't thrash the cache. The provider never exposes a `serverOnly`
  list's bytes through any route.
- **`serverOnly` lookup budget** (08 §4): the first read batch of `/actions` and `/preview` also
  loads the user's and the game's remaining lookup budget. Before the module runs, the framework
  reserves the action's worst case (for `words`, `placements + 1` words); if that doesn't fit, it
  returns `429` without calling the module. The `has()` wrapper passed to the module counts real
  lookups and throws a sentinel (→ `429`, transition aborted) if they exceed the reservation, so a
  request that crosses the limit never returns `INVALID_WORDS`. Unused reservation is refunded in
  the transition batch. An exhausted budget blocks moves as well as previews in that game until the
  window passes; the limits are sized well above normal play.
- `ResourceProvider` (framework): `authorizeForNewGame(kind, id, userId)`, `listForUser(kind,
  userId)` (feeds `OptionsContext.resources` and the catalog), `load(kind, id)`, and per kind an
  `unknownCode` (`UNKNOWN_DICTIONARY`) used if authorisation fails after option resolution
  (02 §2.1 rule 7). Dictionaries are its only kind in v1; their config (`DICTIONARIES_ENABLED`,
  `DICTIONARY_UPLOADS`, `DICTIONARIES_EXTRA`) is framework config (09 §1).
- Upload validation is one streaming linear pass over a pre-sorted file. On Workers Free (10 ms
  CPU) a multi-MB pass may exceed the limit. Measure in M6; if it does, document that uploads need
  Workers Paid (or Docker).
- Client: the dictionary a game uses is fetched lazily when that game is opened (and on the
  new-game screen for the selected one), as a hashed, brotli/gzip-compressed static asset
  (~400–500 kB for ENABLE), cached by the service worker. Previews degrade gracefully (score shown,
  "validity unknown") until loaded.

## 11. Latency budget (Cloudflare)

D1 has a single primary region. To meet the move-submit target (01 §6):

- Enable **Smart Placement** so the Worker runs near D1.
- A move submit performs at most **2 sequential D1 round trips**: (1) one `batch()` of reads
  (session lookup + rate-limit increment + game load), (2) one `batch()` for the transition.
  Session `last_seen_at` refreshes and publishes happen in `waitUntil`.
- The target applies to players on the same continent as the D1 primary; measure from elsewhere and
  record the numbers in M3.
