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
6. **API first.** Every capability is an endpoint of the public, versioned HTTP API (`/api/v1`,
   05) before it is a screen. The web app is one client of that API, through the same generated
   typed client (`@your-move/api-client`) that the MCP server (02 §9.4) and other developers use.
   There are no private endpoints for the web app; operator-only endpoints live in the separate
   Admin API (05 §Admin API).
7. **Games are packages.** The framework knows games only through installed game packages (02 §7),
   composed at build time; first-party games get no special path.

## 2. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict), ES2023 target, ESM (11 §2) | Shared types across engine/server/client |
| Package manager | pnpm workspaces | Fast, strict, good monorepo support |
| HTTP framework | [Hono](https://hono.dev) | Runs natively on Workers and Node; tiny; typed routes |
| Validation and API description | Zod, with Hono's OpenAPI integration (`@hono/zod-openapi`) | One schema per endpoint drives validation, the generated OpenAPI 3.1 document and the generated typed client (05 §Conventions) |
| DB access | Drizzle ORM + drizzle-kit migrations | First-class D1 driver, a proxy driver for anything else, same schema |
| Node SQLite driver | `node:sqlite` (Node's built-in `DatabaseSync`), WAL mode, through Drizzle's `sqlite-proxy` driver | Synchronous like better-sqlite3, but no native module: no install script, no downloaded binary, nothing added to the image (M2a) |
| Node WebSockets | `ws` (via `@hono/node-ws` or direct) | Standard |
| Frontend | React 18+, Vite, React Router | As requested; Vite has the best PWA tooling |
| PWA | A small hand-written service worker (`apps/web/sw/sw.js`) emitted by a Vite plugin; the manifest is served by the server at runtime | No `vite-plugin-pwa`/Workbox dependency (07 §4) |
| Client state | TanStack Query for server state; small local store (Zustand or `useReducer`) for board drag state | Keep it simple |
| Styling | CSS modules or plain CSS with custom properties | No heavy UI kit; we need full control of the board |
| Tests | Vitest (unit + integration), fast-check (property tests), Playwright (e2e, mobile viewports) | Same test runner across packages; details in 11 §4 |
| Lint/format and repo tooling | ESLint (typescript-eslint strict, type-checked) + Prettier, dependency-cruiser, knip, Changesets, Renovate | 11 (engineering standards) |
| Toolchain | mise pins Node (26 LTS) and pnpm (12) | One pinned toolchain for developers and CI (11 §1) |

## 3. Repository layout

```
/
├─ apps/
│  ├─ web/                 React PWA (Vite); a client of the public API via @your-move/api-client
│  ├─ worker/              Cloudflare entry: Worker fetch handler, Durable Object classes,
│  │                       cron handler, wrangler.toml (template), D1 binding
│  └─ node/                Node entry: HTTP server, ws hub, SQLite, interval scheduler,
│                          Dockerfile, docker-compose.tunnel.yml, docker-compose.caddy.yml (09 §4)
├─ packages/
│  ├─ sdk/                 @your-move/sdk — GameDefinition, GameClientModule, GameManifest types,
│  │                       RandomSource, Resources, client helpers (02 §2, §3, §7). Published.
│  ├─ testkit/             @your-move/testkit — generic test kit + architecture rules for game
│  │                       packages (02 §6, §7.5). Published.
│  ├─ api-client/          @your-move/api-client — typed client generated from the OpenAPI
│  │                       document (05). Published.
│  ├─ mcp/                 @your-move/mcp — local MCP server over the API (02 §9.4). Published.
│  ├─ dictionary/          @your-move/dictionary — dictionaries/<id>/ (source, meta,
│  │                       additions/removals), build script, lookup (a framework resource provider)
│  ├─ shared/              @your-move/shared — Zod schemas for the API + WebSocket protocol; the
│  │                       source of the OpenAPI document
│  └─ server/              @your-move/server — runtime-agnostic Hono app: framework (lifecycle,
│                          transitions, lobby, timeouts), accounts, tokens, admin, routes,
│                          repositories, rate limiting, email templates. Depends on a `Platform`.
│                          Knows games only through the registry injected into createApp (§4);
│                          never imports generated/ or any game package.
├─ games/                  First-party game packages, each with /engine, /client, /manifest (02 §7)
│  ├─ example/             @your-move/game-example — reference module and template for authors
│  ├─ words/               @your-move/game-words (engine includes rulesets/<id>/v<N>.json)
│  └─ paths/               @your-move/game-paths
├─ instance.config.ts      Installed game packages for this instance (02 §7.3)
├─ generated/              Server registry, client import map and installed.json from `pnpm games:generate` (ignored by
│                          git, never committed); imported only by apps/worker, apps/node, apps/web
├─ mise.toml, mise.lock    Pinned Node, pnpm and gate tools, with checksums (11 §1)
├─ scripts/                @your-move/scripts (private) — repository tooling: games:generate/verify/
│                          check-db, api:generate, licence and vulnerability gates, gates:prove,
│                          scripts/ci/ (verified tool installs for CI and the Dockerfile)
├─ tests/                  contract/ (the API contract suite on both builds) and e2e/ (Playwright)
├─ config/                 local-dev.env: the public local-development configuration (06 §4)
├─ docs/spec/              This specification
├─ docs/adr/               Architecture decision records (11 §10)
├─ docs/guides/            Developer guides, e.g. writing-a-game.md (11 §11)
├─ .claude/agents/         Agent definitions (coder, picky reviewer, security reviewer)
└─ LICENSE (BSD-2-Clause)
```

Package scope: `@your-move/*`. Package names are the project's identity, not branding: a fork that
rebrands changes `APP_NAME` (09), not package names. Packages meant for outside use are published
(02 §7.4); the rest are private workspace packages (`"private": true`).

## 4. The `Platform` port

`packages/server` exports `createApp({ platform, games }: { platform: Platform; games: GameRegistry }): Hono`.
`games` is the generated server registry (`type → { manifest, engines }`, 02 §7.3), which
`apps/worker` and `apps/node` import from `generated/` and pass in, so the server package itself
never depends on any game package. Each runtime builds a `Platform`:

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
  clientIp(request, env): ClientIp; // the client address (08 §4.1): CF-Connecting-IP on Workers, by TRUST_PROXY on Node
}
```

**Background work is per request.** `waitUntil` is not a `Platform` member: on Workers it belongs
to each request's `ctx`, and an app built once per isolate must not capture one. The runtime passes
an execution context with every request (`app.fetch(request, env, ctx)`: the Worker's own `ctx`;
on Node, one whose `waitUntil` tracks the task so shutdown waits for it), and the core reaches it
through Hono's `c.executionCtx.waitUntil`. Background tasks start after the response and their
errors are logged by class only.

**Database boundary.** Drizzle's D1 driver is async and supports `batch()` but not interactive
transactions; `node:sqlite` is synchronous and has transactions but no batch API. So core code
never touches a Drizzle database object. Instead:

- `packages/server/src/db/schema.ts` holds the one shared Drizzle schema.
- Core depends on async repository interfaces (`UserRepo`, `SessionRepo`, `OtpRepo`, `GameRepo`,
  `RateLimitRepo`, …) whose methods express whole operations, e.g.
  `GameRepo.applyTransition(gameId, expectedVersion, writeSet): Promise<"ok" | "stale">`.
- Shared query-building code lives in `packages/server/src/db/queries/*` and produces Drizzle query
  objects; the repository implementations (`packages/server/src/db/`, written once) run them
  through an async Drizzle database with `batch()` that each adapter supplies: D1 → Drizzle's D1
  driver, whose `db.batch([...])` is D1's transactional batch; Node → Drizzle's `sqlite-proxy`
  driver over `node:sqlite`, whose batch callback runs the statements inside one synchronous
  `BEGIN IMMEDIATE … COMMIT`. That transaction is the only one: a statement through the driver
  that begins, ends or nests a transaction is refused by its text (after any leading comments),
  and as a backstop a statement that opens a transaction from autocommit is rolled back and
  refused, and one that closes the batch's transaction is refused before the batch's next
  statement runs. Only `src/db/` and the two adapters (`apps/node/src/db/`,
  `apps/worker/src/d1.ts`) import Drizzle (a dependency-cruiser rule, 11 §5).
- A shared repository contract test suite (`@your-move/server/testing`) runs against **both**
  adapters: Node in-process on a real file; D1 in workerd, migrated with
  `wrangler d1 migrations apply --local` and reached through Wrangler's `getPlatformProxy` (in
  CI's arm64 `test:worker` job, 11 §9). `@your-move/server/testing` (the suite and test helpers
  such as `createSession`) and `@your-move/node/db` (the Node adapter, for the contract tests) are
  exports for tests only: production code reaches the adapter by path and never imports either.

**Randomness.** Production randomness always comes from WebCrypto (`crypto.getRandomValues`,
`crypto.randomUUID`). The engine receives it as an explicit `RandomSource` argument (02 §2); the
server constructs the WebCrypto-backed source in exactly one place. Only tests construct seeded
sources: `createApp` takes an optional `random` source factory that runtimes never pass, and the
framework's tests pass a seeded one and print its seed on failure.

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

**Durable Objects hold no state of record.** `UserChannel` only relays "something changed"
invalidations to a user's open sockets (§6); it stores nothing a client couldn't lose, and every
read and every action still goes through the HTTP API (principle 6). That is also why the Docker
target, which has no Durable Objects, behaves identically: the API is the contract on both, and
the same contract test suite runs against both builds (11 §4).

### 5.2 Game state transitions (actions and everything else)

Every `games` row has an integer `version` and a `write_token`. **Every** state change to a game —
action, join, accept, remove, start, resign, decline, leave, cancel, expiry, timeout (02 §4) — is a
*transition* applied like this. (Invite claims update only the claimed `game_players` row, guarded by
its state, `delivery <> 'inert'`, the claimant holding no other row in the game, and the game
`version` being unchanged since it was loaded — checked but deliberately not bumped, 02 §4. The
email-nudge throttle `game_players.last_nudged_at` is not game state either: one conditional
update of that row, re-checking everything that made the nudge due, with no version bump, §7. A
finished game's rematch link `games.rematch_game_id` is not game state either: it is written in
the batch that inserts the rematch, by one conditional update guarded on the game being `finished`
and the link being NULL or naming a game that ended unplayed, with every insert of the batch
guarded the same way and no version bump, 04, 05 `POST /api/v1/games/:id/rematch`. Two writes make
an invitation `inert` without a transition: the block's own batch (05 §Blocks, alpha A23) sets
`delivery = 'inert'` on the person blocked's open invitations (`invited`, `normal` or `hidden`) in
`lobby` games the blocker has joined (and, for a blocker who joins later, the same flip restricted
to that game is one more statement of their accept's or link join's own transition, guarded by its
token like every dependent write, so it happens only if that transition won; A23-S3-1), and the
under-age exit's batch (06 §5, alpha A21) sets it on
the `invited`, user-less email-invite seats typed as the leaving address, every statement of that
batch guarded on the account's `onboarded_at` still being NULL. Neither touches any other row, the
game row or its version, and neither needs a version check: an accept is guarded in its own batch
against a block (A23-S-4) and a claim never takes an `inert` row, while a Start (which drops the
row) and a Remove (which removes it) write over it whatever its delivery, and no transition reads
`delivery` to decide anything but whether the holder may still see or accept the invitation. The
under-age exit's entry closes alpha A21's omission from this list.)

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

On Node the same statements run inside one synchronous `node:sqlite` transaction (when statement 1
changes nothing, every guarded statement matches nothing too, so the commit writes nothing), and
they are generated by the same shared query code, so behaviour is identical. Statement 1 ends in
`RETURNING id`, and its affected-row count is read as the number of rows returned, which is the
same on both drivers.

Required tests (M3/M4): two concurrent moves at the same version → exactly one succeeds and the
database matches the winner's state exactly, on both drivers; same for move-vs-decline,
**sweep timeout vs a last-second move**, start-vs-cancel, accept-vs-remove, accept-vs-cancel,
remove-vs-join, an accept or join that triggers an automatic start, join-vs-join for the last open
seat, and the invite-claim races (02 §4): claim-vs-start, claim-vs-remove, claim-vs-cancel, and
**create-vs-onboarding** (a game created while the invitee completes onboarding is claimed by the
sweep, 06 §6.4), and **rematch-vs-rematch** (several rematches of one finished game created
together, and replacements of one that ended unplayed: exactly one is created, and the others
leave no row, alpha A15).

Clients send `expectedVersion` with every client-initiated transition, which doubles as
double-submit protection. Transitions the server starts itself (join, sweep, account deletion)
reload and retry up to 3 times on `stale`; if the transition no longer applies after a
reload (e.g. the seat filled), the caller gets the outcome for the new state (e.g. the join link's
indistinguishable `404`).

### 5.3 Docker storage

Single SQLite file on a mounted volume (`/data/app.sqlite`), WAL mode, `busy_timeout` set,
`foreign_keys=ON`, and SQLite's defensive flag (no `writable_schema`) set explicitly, whatever
Node's default. Backups: documented `sqlite3 .backup` / Litestream recipe in 09.
The Node runtime is **single-instance** by design; running two containers against one file is
unsupported and the app SHOULD refuse to start if it detects another live instance (lock file).
M2a: the lock is SQLite's own exclusive lock on `<DATABASE_PATH>.lock`, held by an open
transaction for the life of the process and taken before migrations, which run on a connection of
their own that is closed before the server's connection opens (04 §Migrations); the operating
system drops the lock however the process exits, so a crash leaves no stale lock (on a local filesystem; network
filesystems are unsupported for the database anyway).

## 6. Realtime

- Client opens one WebSocket per signed-in app instance: `GET /api/v1/ws` (cookie-authenticated,
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
  recipient per day (06 §6.2). Every other lobby event (joins by others, accepts, declines, leaves,
  removals) and lobby endings (`cancelled`, `expired`, `declined` from the lobby, including cancels
  caused by account deletion) send realtime invalidations only — no push, no email (02 §4). iOS
  supports this only for home-screen web apps (16.4+) and only after a user gesture grants
  permission — the UI asks after the first game is created or the first invitation is accepted
  (Q28), not at sign-in.
- Push text is built only from public `describe` text (02 §5) and display names, never from state
  (e.g. "Alex played QUIZ for 64. Your turn."). The auto-join push is "<creator> added you to a
  game"; the invitation push names nobody (06 §6.2).
- Implemented once in `packages/server` using WebCrypto (RFC 8291 aes128gcm + RFC 8292 VAPID) or a
  vetted Workers-compatible library; must work on both runtimes.
- **Turn and game-end pushes (alpha A8).** Implemented with WebCrypto alone, no library. A
  transition that won its race schedules its pushes in the background (§4) after the response, so a
  push never delays or fails the action; nothing is sent without VAPID configured (09 §1). "Your
  turn" goes to each seat whose clock the transition started (`to_act_since` set: it entered
  `toAct`, the start included, 02 §2.3), and "game over" to every seated player when a game that
  reached `active` ends (`finished`, or `declined` after the start); **never to the user whose
  request made the transition**, who is looking at it (so a seat whose own action restarts its clock
  gets nothing, and the creator who presses Start isn't told it's their turn). The message is `{
  title, body, url, tag }`: `title` is `APP_NAME`; `body` is the transition's `describe` text with
  names filled in ("You" for the recipient, "New player" and "Deleted player" as for the email
  nudge) as a sentence followed by "Your turn." or "The game is over."; a start, which has no
  `describe` text, says "Your game with <the other players> has started. Your turn.", and a
  framework-only `declined` ending "<name> declined the game, so it's over."; the body is cut to 240
  code points (so a cut never splits a surrogate pair); `url` is the game's path `/g/<id>` and `tag`
  is `game-<id>`, so a newer notification for a game replaces an older one. Each request carries
  `TTL: 86400` (the email nudge covers a longer wait) and `Urgency: normal`. A push service's `2xx`
  sets `last_success_at`, `404`/`410` deletes the subscription, and anything else (a redirect,
  another status, a network error or the 5 s timeout, 08 T12) is logged by status or error class
  only, never the endpoint (a capability URL) or the text. Only subscriptions whose session is live
  are sent to (the session check's own expiry rules, 06 §4: a session past its expiry is deleted
  only at its next use, and until then gets nothing). At most 40 subscriptions are sent to per
  transition (a Worker invocation's subrequest budget, 09 §3), taken in turn by recipient (each
  one's first device, then each one's second, a recipient's devices most recently useful first), so
  no recipient's devices crowd out another's; the delivery marks and deletions are one statement
  each.
- **The auto-join push (alpha A12).** When a past opponent picked from the list is added at once
  (06 §6.2), the create request schedules, in the background like a transition's pushes, one push to
  each added player and never to the creator: `body` is "<creator> added you to a game." (the
  creator's display name, "New player" without one), or "<creator> wants a rematch." when the game
  is a finished game's rematch (05 `POST /api/v1/games/:id/rematch`, alpha A15; only a rematch
  with one person carried over adds anyone at once, Q29), followed by " Your
  turn." when the game started at creation and the added player's seat is to act; `url`, `tag`, the
  TTL, the 240-code-point cut, the per-request cap of 40 and the live-session rule are as above.
  The start at creation sends no "your turn" push of its own: the auto-join push says it, so an
  added player gets one notification, not two (they'd share a `tag` anyway). The push reads the game
  when it is sent: nothing once the game has ended (a decline that won the race with the start ends
  a two-seat lobby), and only to added players still `joined` or `playing`. A start at creation that
  fails is logged by error class and leaves the created lobby, which the `201` shows; the push is
  scheduled either way.
- **The invitation push (alpha A20).** A create (or rematch) request that seats a `normal`
  invitation with a user (06 §6.2) sends, from the one background task it schedules for its
  invitations whatever they are (with the invite emails, 06 §6.3), "You have a new game
  invitation." to each such invitee: `url` `/`, `tag` `invitation`, never naming the creator or
  the game; it reads the game when it is sent and pushes only to rows still a `normal` invitation
  in a `lobby`. A claim that makes a `normal` invitation (06 §6.4) sends the same push to the
  claimant, after the onboarding response or from the sweep's claim step. At most one per
  recipient in a fixed UTC day: the per-recipient counter `INVITATION_PUSHES_USER_DAY` (08 §4) is
  taken in the background, after the subscriptions are read and only for a recipient who has a
  live one, so it is never read or written by the request a creator sees. It is taken **before**
  delivery, on purpose (review A20-S-5, P-7): one atomic count decides the day's push, so racing
  invitations can't both send, and no outcome is written back; a send that fails, or a recipient
  cut by the cap of 40, has still used up that day's push. The push runs after the same task's
  emails, `sent_at` and the invite-email cap's alert and day stop (review A20-S-2, 09 §3). On Node
  the task shares the server's event loop, so it can delay the next requests by the work of its
  sends, as A17's invite emails can; nothing of it reaches a response (review A20-S-6, 06 §6.6).
  TTL, urgency, the live-session rule, the cap of 40, the delivery marks and deletions are as
  above.
- Optional email nudge (default off, per-user setting): "It's your turn" after 24 h idle, max one
  per game per day; and at most one email per normal invitation, sent when it's created (06 §6.2; alpha
  A20), never by the sweep or a claim. Precisely (alpha A6): the sweep nudges a `playing` seat of an
  `active` game whose `to_act_since` is at least 24 h old ("idle": in `toAct` that long without
  acting) and whose `last_nudged_at` is unset or at least 24 h old, if its user is a human with
  `settings.emailNudges` true, onboarded, not suspended or being deleted, whose `email_id` is set
  and has no `bounced` or `complained` row in `email_suppressions`. An `unsubscribed` row doesn't
  stop nudges: only the invites unsubscribe and the under-age exit write one, and nudges have their
  own opt-out (the setting, and `email_id`, which a `nudges` unsubscribe clears). Only games of an
  installed game type and rules version are looked at, in SQL, so orphaned games never take a place
  in the queue. A run's page holds at most one seat per recipient (their least recently nudged, then
  longest waiting), recipients nudged least recently in any game first, so neither one recipient's
  many games nor a recipient held back by their own cap keeps anyone else waiting; a recipient's
  other due games follow in later runs. Two daily caps apply (08 §4): instance-wide
  `LIMIT_NUDGE_EMAILS_PER_DAY` and per recipient `LIMIT_NUDGE_EMAILS_PER_USER_PER_DAY`. The run
  reads the room left under each without counting; a nudge over either waits unclaimed for a later
  run (at the instance-wide cap the run stops), only claimed nudges are counted, and the
  instance-wide cap is alerted once per fixed window, through a counter of its own. Then
  `last_nudged_at` is claimed with one conditional update that re-checks everything above — the
  seat, the game being `active` and the user's eligibility — **before** the email is sent (so two
  sweeps can't both send, an unsubscribe or a move in between stops it, and a failed send isn't
  retried that day), and the claimed nudge is counted. The room is read once per run, so the run
  also checks the instance-wide count each claimed nudge adds: one that goes over the cap (only
  possible when two runs overlap) isn't sent, the run stops there as at the cap, and that seat is
  due again once `NUDGE_INTERVAL_MS` (24 h) has passed since the claim, so no fixed UTC day sends
  more than the cap (08 §4.2). It is a notification throttle, not game state: it is not a transition
  (§5.2) and doesn't bump `version`. The email is a fixed template: the game type's name, the other
  seated players' display names ("New player" for a name that isn't set, "Deleted player" for a
  deleted account, 02 §5, 04), the last public `describe` text (names filled in, "You" for the
  recipient), a link to the game, and the unsubscribe link and headers (05 §Email links) — never
  state, options, totals or standings (a move's points only as its `describe` text gives them), nor
  addresses (08 T18). A run sends at most a per-runtime number of nudges, bounded by what one
  invocation may spend (100 on Node; 4 on Workers, 09 §3); the rest wait for the next run. Turning
  nudges on deletes only the address's own `unsubscribed` row (its holder's opt-in, review
  A20-P-3); a `bounced` or `complained` row stays and keeps stopping them (surfacing that in
  Settings is M4's, with bounce handling).

## 8. Scheduled work

(Turn timeouts are applied here and nowhere else. GET handlers never write game state, with one
exception: **lazy lobby expiry**. A read or write of a game by a member first applies the expiry
transition if it is a lobby past its 14 days (a stranger's `404` never writes), and listing or
creating games first expires the caller's overdue lobbies (at most 20 per request, oldest first,
the rest on the next request), so no overdue lobby is accepted or started (both refuse it whatever
its status says), and its typed addresses are cleared (06 §6.5) as soon as anyone involved comes back. It's a
transition like any other (§5.2), so it bumps the game's version: a member sees the game unread,
and a request in flight with the earlier `expectedVersion` gets `STALE_GAME`. `start` and `accept`
also refuse a lobby at or past its expiry. Past the 20-per-request bound a list may still show
some overdue lobbies as open until a later request expires them. The alpha's sweep has the
email-nudge step (A6), the invite-claim and lobby-expiry steps (A17), which expires the
lobbies no one comes back to, so a typed address never outlives its lobby for long, and the join-link expiry (A18), which deletes links past
`expires_at`.)

One `sweep()` function in core, invoked by Cloudflare Cron Triggers (`*/15 * * * *`) or a Node
`setInterval` (every 15 minutes, first run 15 minutes after start; a run still going when the next
is due skips that one). A failing step is logged (by class, never its message, 09 §5) and the
other steps still run. Every step is idempotent and uses the same transition mechanism as actions,
except notification throttles such as `last_nudged_at` (§7) and invite claims, which are guarded
row updates that check the game's version without bumping it (02 §4, §5.2):

- Expire OTPs, sessions, invites, join links and rate-limit buckets.
- Delete accounts that haven't completed onboarding 7 days after creation — only rows with
  `onboarded_at IS NULL`, never users re-prompted after a `MIN_AGE` rise (06 §5).
- Claim any `invited`, non-`inert` email seat in a `lobby` game whose `invite_email` matches an
  onboarded user who holds no other row in that game, with the same guard as an onboarding claim
  (catches games created during onboarding and failed claims; 02 §4, 06 §6.4). The user must be
  an onboarded human, not suspended or being deleted, and the lobby not yet due to expire; at
  most a per-runtime number of seats per run, oldest lobby first (alpha A17, 09 §3). This is also
  the catch-up for the request that completes onboarding, which claims at most a per-runtime
  number of seats (Node 50, the Worker 8, 06 §6.4).
- Apply per-seat turn timeouts via module `onTimeout`: overdue seats one transition at a time, in
  seat order, reloading and re-checking `toAct` and the deadline before each (02 §4).
- Send timeout reminders (50 % and 24 h before, 02 §4; tracked in `timeout_reminders_sent`, which
  every clock restart resets to 0).
- Expire lobbies 14 days after creation (reads and writes also expire them lazily, above): the
  same expiry transition, retried on `stale`, at most a per-runtime number per run, oldest first
  (alpha A17, 09 §3).
- Send due email nudges.
- Purge blobs of deleted dictionaries no `lobby`/`active` game references (`game_resources`), and
  delete row-less upload blobs older than 1 h (words §9.5).
- Resume unfinished account deletions (04 §Account deletion).
- Cancel **orphaned** `lobby`/`active` games — a game type or rules version no longer installed
  (only possible after a deploy with `--allow-orphans` / `ALLOW_ORPHAN_GAMES`, 02 §7.3) — with
  operator-cancel semantics, no ranking and `final_views` NULL.
- Expire API tokens past `expires_at` (they're already refused; this only tidies rows).

## 9. Static assets and routing

- Server-handled paths: `/api/*` (including the server-rendered unsubscribe page,
  `/api/v1/email/unsubscribe`, 05 §Email links), `/manifest.webmanifest` (generated at runtime from
  config so a prebuilt image/bundle carries no name — 07 §4), and `/__dev/*` (returns 404 unless
  local-dev mode, 06 §4). Everything else → built SPA from `apps/web/dist` with SPA fallback to
  `index.html`. An M4 e2e test GETs and POSTs the unsubscribe URL on both targets with the service
  worker active.
- `index.html` contains no product name; the SPA sets `document.title` and the
  `apple-mobile-web-app-title` meta at startup from `/api/v1/config` (verify the iOS home-screen label
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
  isolate/process. Each compact sorted word list is read from disk on Node and fetched once per
  isolate from the static-assets binding on Cloudflare, so the Worker and the clients share one
  copy of each list (the served layout below; bundling the lists into the Worker as text modules
  was the plan until alpha A2). Lookup is a binary search directly over
  the text (no parse), or any index is built outside request handling, never inside a request.
  Memory < 25 MB per loaded dictionary. Measure Worker startup time and per-lookup CPU in M1 and
  record the numbers (M1, in `packages/dictionary/README.md`: under 1 µs CPU per ENABLE lookup,
  about 3.5 MB resident, a one-time load of about 4 ms CPU of which the SHA-256 check of the
  list is about 2.5 ms, and no startup cost the local profiler can resolve from bundling the
  list as a text module; the real startup time is recorded at the first Workers deployment).
  Each built-in list is checked against its manifest's size and SHA-256 once per load, before
  first use.
- **Served layout (alpha A2).** The dictionary build also writes `generated/served/`: the index
  (`index.json`) and each word list, with its `.gz` and `.br` copies, under its versioned, hashed
  name `<id>-v<version>.<first 16 hex digits of wordsSha256>.txt`. Clients download it at
  `/assets/dictionaries/<that name>` (the `downloadUrl` the framework sets for public lists, words
  §9.4), cached as immutable like every hashed asset. The index is unversioned, so it is never
  published under `/assets/`: on Cloudflare the build copies the word lists (without the `.gz` and
  `.br` copies, as Cloudflare compresses static assets itself) into the static assets and the index
  to `/dictionaries/index.json`, which Cloudflare's default revalidates, and the Worker reads the
  index (once per isolate, when the app is built) and each list (on first use) through the
  `ASSETS` binding; on Node the build copies the layout to `dist/dictionaries`, which the server
  reads from disk, serving only the word lists (with their precompressed copies). Around the
  runtime's `loadText` the core adds a 10 s timeout, and it remembers any failure of the whole
  load (a list whose size or hash doesn't match its manifest included) for 30 s before fetching
  or hashing that list again (10 M3).
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
  request that crosses the limit never returns `INVALID_WORDS`. The lookups actually made are
  always charged; the unused part of the reservation is refunded in the transition batch, or — when
  there is none (a failed `validate`, any preview) — by one follow-up write after the response. An exhausted budget blocks moves as well as previews in that game until the
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
