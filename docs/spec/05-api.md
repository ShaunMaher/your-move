# 05 — API

The product is **API first** (03 §1 principle 6): every capability is an endpoint here, and the web
app, the MCP server (02 §9.4) and anyone else's tools are clients of the same API.

## Versioning, schemas and the OpenAPI document

- Everything lives under **`/api/v1`**. `GET /api/health` also answers unversioned (for load
  balancers and Docker health checks); everything else, including the WebSocket, is under
  `/api/v1`. Paths in this document are written in full.
- **One schema per endpoint.** Each route's request, response and error shapes are Zod schemas in
  `@your-move/shared` (the client-facing types a game client also needs — `GameEnvelope`,
  `SubmitResult` and friends — are Zod schemas defined in `@your-move/sdk`, which the server
  registers as they are, 02 §7.4), registered through `@hono/zod-openapi`. Because the server
  registers the SDK's own schemas, the types generated for `@your-move/api-client` are structurally
  identical to the SDK's; a type-level test asserts the two are mutually assignable. They drive request validation (unknown fields rejected with
  `.strict()`), response typing, the generated **OpenAPI 3.1** document served at
  `GET /api/v1/openapi.json` (**public**), and the generated typed client `@your-move/api-client`
  (`openapi-typescript` + `openapi-fetch`, 11 §3). Each operation carries an `x-scope` extension
  (§Token scopes). There is **no rendered docs page in v1**: common renderers need inline styles
  that the CSP forbids (08 §3); developers load `openapi.json` into a viewer of their choice.
  Game-specific payloads appear in the document as `unknown` with a pointer to the installed game's
  own schemas, published per game type at `GET /api/v1/games/types/:type/schemas` (**public**;
  JSON Schema generated from the module's Zod schemas), and its rules at
  `GET /api/v1/games/types/:type/rules?version=` (**public**; the manifest's Markdown, 02 §7.2;
  latest rules version by default).
- The Admin API (§Admin API) has its own document, `GET /api/v1/admin/openapi.json`, served only to
  admins; it is never part of the public document.
- **Compatibility within v1 is additive only**: new endpoints, new optional request fields, new
  response fields, new error codes on existing statuses, new enum values in responses (clients
  must tolerate unknown values). Anything else — removing or renaming a field or endpoint, making
  an optional input required, changing a type or a status — is a **breaking change** and goes to
  `/api/v2`, which runs alongside v1 for at least 6 months. Endpoints scheduled for removal send
  `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) headers and are listed in the changelog.
- A CI check compares the generated OpenAPI document with the one on the target branch and fails
  on a breaking change within v1 (`oasdiff breaking`, 11 §9).
- **Contract tests**: one API test suite, written against `@your-move/api-client`, runs against
  both the Node build and the Worker build (Miniflare) in CI (11 §4).

## Conventions

- Auth: session cookie (06 §4) **or** an API token sent as `Authorization: Bearer ym_pat_…`
  (06 §8). Endpoints are authenticated unless marked **public**. Which credential each route
  accepts — public, session only, or a token with a given scope — is defined once, in
  §Token scopes, and anything not listed there is **denied** (deny by default).
- A request carrying both a cookie and a bearer token is rejected (`400 BAD_REQUEST`). Tokens are
  accepted **only** in the `Authorization` header: never in a query string, cookie or WebSocket.
  The `Authorization` header is never logged, by the app or at the edge (09 §5).
- **No CORS in v1**: the API sends no `Access-Control-Allow-*` headers, so browsers on other origins
  can't call it; scripts, CLIs and the MCP server (which aren't browsers) use tokens.
- State-changing requests (`POST`/`PATCH`/`DELETE`) **authenticated by cookie** MUST carry an
  `Origin` header equal to `PUBLIC_URL`'s origin, else `403 BAD_ORIGIN` (CSRF defence, 08).
  Any other state-changing request whose `Origin` names a different origin also gets
  `403 BAD_ORIGIN` (with no CORS no legitimate browser sends one; scripts without `Origin` are
  unaffected). Bearer-token requests are exempt from the Origin rule: browsers never attach them automatically,
  so they can't be forged cross-site. Requests **with a body** MUST be
  `Content-Type: application/json`, else `415`. Body-less `DELETE`s are allowed (Origin still
  required). Endpoints that take no input accept an empty body or `{}`.
- **Exemptions**, listed explicitly in code and nowhere else: the unsubscribe route (§Email links)
  are exempt from both rules; the dictionary upload route (§Dictionaries) is exempt from the JSON
  rule only (Origin still required).
- Request body limit: 16 kB, except the dictionary upload route (8 MB, streamed). Larger → `413`.
- Errors: `{"error": {"code": "SOME_CODE", "message": "Human readable", "detail"?: ...}}` with an
  appropriate status (§Errors). `message` is for display; clients branch on `code`.
- All list endpoints return at most 100 items with cursor pagination (`?cursor=`) where needed.
- Responses set `Cache-Control: no-store`.

## Auth & account

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/v1/auth/otp/request` **public** | `{ email }` | `202 {}` — always identical regardless of whether the email is known, rate-limited, or suppressed. Rate limiting is reported only when the *IP* is limited (`429 RATE_LIMITED`), never per email. |
| POST | `/api/v1/auth/otp/verify` **public** | `{ email, code }` | `200 { user, needsOnboarding }` + `Set-Cookie`. `needsOnboarding` is true until a display name is set and the age confirmation given for the current `MIN_AGE` (06 §5). Errors: `400 INVALID_CODE` (wrong, expired, consumed or unknown — indistinguishable), `429 RATE_LIMITED`. |
| POST | `/api/v1/auth/logout` | `{}` | `204`, clears cookie, deletes session |
| POST | `/api/v1/auth/logout-all` | `{ revokeTokens?: boolean }` | `204`, deletes all of the user's sessions; with `revokeTokens: true` (the app offers it, checked by default) also revokes every API token of the user and their AI accounts |
| GET | `/api/v1/me` | | `200 { id, kind, email, displayName, settings, ageAttested, needsOnboarding, isAdmin }` or `401` (`kind` is `agent` and `email` null for an AI account's token; `isAdmin` lets the client show admin links, it grants nothing). `needsOnboarding` is true until onboarding is complete, and again for a re-prompted user after a `MIN_AGE` rise (06 §5) |
| PATCH | `/api/v1/me` | `{ displayName?, settings?, ageAttested?: true }` | `200` user. `settings` accepts only known keys (`emailNudges`, `whoCanAddMe`, theme; alpha A6 accepts `emailNudges` only, M4 the rest), each optional, and changes only the keys given; `emailNudges: true` for an account without an address is `400 BAD_REQUEST`. The request that completes onboarding sets `onboarded_at` and claims email-invite seats (06 §6.4). Display-name changes after onboarding: at most 3 per 30 days (`429 RATE_LIMITED`), each logged (06 §5) |
| POST | `/api/v1/me/under-age` | `{}` | Only while `needsOnboarding` is true. A new account (`onboarded_at` NULL): deletes the account and its sessions at once, with no step-up code (06 §5, 04 §Account deletion), suppresses invite emails to the address and makes its email seats `inert`. A re-prompted account (onboarded, after a `MIN_AGE` rise): signs out this session only and deletes nothing (deletion needs the step-up flow below). `204`, clears cookie; `409 WRONG_STATUS` when `needsOnboarding` is false |
| POST | `/api/v1/me/delete/otp` | `{}` | `202` — emails a `delete_account`-purpose code (06 §7) |
| DELETE | `/api/v1/me` | `{ code }` | `204` if the code is a valid `delete_account` code; else `400 INVALID_CODE` |
| GET | `/api/v1/me/sessions` | | list of `{ id, createdAt, lastSeenAt, userAgent, current }` |
| DELETE | `/api/v1/me/sessions/:id` | (none) | `204`; `404` if not one of the viewer's sessions |

## Games (framework — 02)

Game-specific payloads (`options`, `action`, `view`, `record`, `preview`) are defined by each game
module (games/*.md) and validated by the module's schemas; everything else here is common to all
games.

### Common types
```ts
Text = (string | { seat: number })[]          // rendered with current names; "You" for yourSeat (02 §5)

GameEnvelope = {
  id, gameType, gameVersion, options, status: "lobby" | "active" | "finished" | "declined" | "cancelled" | "expired",
  version,                                   // optimistic-concurrency version
  endReason: string | null,                  // module result().endReason, or "declined" / "cancelled" / "expired"
  turnTimeoutDays, seatOrder: "join" | "random",
  aiAssistance: "off" | "allowed",           // 02 §9.3; fixed at creation
  available: boolean,                        // false for an orphaned game whose engine is gone (02 §7.3)
  resources: [{ kind, id, name, distribution?, uploadedBy?: string,
                downloadUrl?: string /* public distribution only: versioned, hashed (words §9.4) */ }],  // never blob keys or hashes
  players: [{ playerId?: string /* game_players.id; creator only, lobby only (for remove-seat) */,
              seat: number | null /* null in lobby */, userId: string | null, displayName: string | null,
              kind: "human" | "agent", aiOwnerName?: string /* agents: the owner's display name, shown as "<owner>'s AI" (02 §9.2) */,
              invitedAs?: string /* creator only, while state is "invited": the address they typed, or the picked past opponent's name */,
              state: "invited" | "joined" | "declined" | "left" | "removed" | "playing" | "out",
              outReason?: "eliminated" | "resigned" | "timed_out" | "declined" | "cancelled", rank?: number, score?: number,
              deadline?: number /* when this seat times out, if in toAct */, isYou: boolean, isCreator: boolean }],
  yourSeat: number | null, toAct: number[], yourTurn: boolean,
  yourInvitation: "normal" | "hidden" | null, // you hold an `invited` seat in a `lobby` (accept/decline); null once the lobby ended; hidden ones never badge
  joinLink?: { active: boolean, expiresAt: number | null },  // creator only, lobby only; the URL is shown only on create/rotate
  canAddPlayers?: { userId, displayName }[], // creator only, finished games: link joiners who acted and aren't yet past opponents — blocked ones are still listed so the prompt reveals nothing; add-player is a no-op for them (02 §4)
  createdAt, lastActionAt
}
GameSummary = { id, gameType, status, endReason, aiAssistance, yourTurn, yourInvitation /* as in the envelope */, players (as in the envelope),
  summary: { headline: Text, scores? },     // module summary(state, yourSeat) while active; the stored final summary after start;
                                            // in the lobby a framework Text, e.g. "Waiting for 2 players"
  lastAction: { describe: Text, byYou: boolean } | null,
  lastActionAt, unread: boolean /* always false for a hidden invitation */, version }
```

**Who sees what in `players[]`.** In the lobby: rows in `invited`, `joined`, `declined`, `left` and
`removed`. **Any row that has never been `joined` (`joined_at` NULL) has `displayName: null` and
`userId: null` for everyone, in every state** — invited, declined or removed alike — so neither a
removal nor a decline reveals whether a typed address has an account (Q3). While the row is
`invited`, the creator also sees `invitedAs`: the address they typed, or the name of a past
opponent they picked by `userId` (which they already know). Once the row is `declined` or
`removed`, `invitedAs` is absent for every kind of row and the creator sees only the state, like
other members ("Invited", "Declined", "Removed"); the typed address has been cleared (06 §6.5). `normal`, `hidden` and `inert`
invitations look identical (Q3, 04). Link joiners (and the join lookup) see only `joined` rows.
After start: only seated players. A player's envelope never contains an email other than the
creator's own typed `invitedAs` values. `kind` and `aiOwnerName` are shown for every row that is
shown at all (AI accounts are always seated by their owner at creation, so they are never
anonymous rows).

### `GET /api/v1/games`
The viewer's games (membership as in 04), newest activity first: all `lobby`/`active`; `finished`
from the last 90 days; `declined`/`cancelled`/`expired` from the last 7 days. Cursor-paginated
(`?cursor=`, 50 per page; `nextCursor`). **Hidden invitations are excluded by default.** Filters:
`?status=`, `?gameType=`, `?invitations=true` (normal invitations), `?invitations=hidden` (the
collapsed *Hidden invitations*, 06 §6.7); both list only invitations whose lobby is still open.
`403 ONBOARDING_REQUIRED` until onboarding is complete.

### `POST /api/v1/games`
```ts
{
  gameType: string,
  options?: unknown,               // module input, see "Remembered options" below
  seats?: number,                  // default: max if min = max, else min; must be within players(options)
  turnTimeoutDays?: number,        // integer 1–30; default module defaultTurnTimeoutDays(options)
  seatOrder?: "join" | "random",   // default "join"
  aiAssistance?: "off" | "allowed", // default "off" if any seat is open or ≥ 2 humans, else "allowed" (02 §4); immutable
  agents?: string[],               // ids of the creator's own AI accounts to seat (02 §9.2); auto-joined
  invitees: ({ email: string } | { userId: string })[],   // humans; agents + invitees ≤ seats-1; userId must be a past opponent
                                   // a token (scope games:create) may name only past opponents by userId and own agents —
                                   // never an email invitee (403 NOT_ALLOWED)
  joinLink?: boolean               // create a join link for remaining open seats
}
```

**Email invitees never reveal whether an address has an account** (06 §6.1, Q3). Every valid email
gets a seat and the response is the same whether the address belongs to an onboarded user (who gets
an invitation), to nobody or to an un-onboarded account (email-invite seat), is on the suppression
list or over an invite cap (seat created, no email sent), belongs to someone with a block in either
direction with the creator or another invitee (an `inert` seat that is never delivered), or belongs
to a user already added in the same request, by `userId` or another address (an `inert` email-only
seat with `user_id` NULL). The work done and the response time are the same in every case (06 §3.2
approach: same reads and writes, emails sent via `waitUntil`). Per-pair limits count an email
invitee by its `emailId` (the HMAC of the typed address), never by the user it resolves to (06 §6.7).

| Case | Response |
|---|---|
| Created | `201 { game: GameEnvelope, joinLinkUrl?: string }` — `active` immediately if every seat is filled by auto-joined past opponents and/or the creator's own AI accounts (no join link requested, and no AI rule in 02 §4 preventing auto-start), else `lobby` |
| Unknown/disabled `gameType` | `400 UNKNOWN_GAME` |
| `resolveOptions` fails (incl. a resource the creator may not use, 02 §2.1 rule 7) | `400 INVALID_OPTIONS { detail: { code, detail? } }` with the module code, e.g. `UNKNOWN_DICTIONARY`, `INCOMPATIBLE_DICTIONARY` |
| `seats` outside `players(options)` | `400 INVALID_SEAT_COUNT` |
| `turnTimeoutDays` not an integer 1–30 | `400 INVALID_TIMEOUT` |
| `validateStart(options, seats)` fails | `409 INVALID_SEATS { detail: { code, detail? } }` — nothing created |
| More invitees than `seats - 1`, **literal** duplicates (the same normalised address twice, or the same `userId` twice), an invalid address, or a `userId` that isn't a past opponent or has a block in either direction with the creator (a block between invitees, or with a member, silently gives the later invitee an `inert` seat, 06 §6.1) | `400 INVALID_INVITEES` |
| The creator's own email or id | `400 CANNOT_PLAY_SELF` |
| An `agents` id that isn't one of the creator's own AI accounts, or an AI account's id or address given as an invitee | `400 INVALID_INVITEES` |
| AI seats in a game type with hidden information while another human seat is possible (02 §4) | `400 AI_SEATS_NOT_ALLOWED` |
| The caller is an AI account's token (agents can't create games, 02 §9.2) | `403 AGENT_NOT_ALLOWED` |
| A token request with an email invitee | `403 NOT_ALLOWED` |
| Creator has too many `lobby`/`active` games they created (per pair > 5, total > 50) — counts only games the **creator** created; a pair is (creator, `userId`) for picked invitees and (creator, `emailId`) for every typed address, whatever it resolves to | `409 TOO_MANY_GAMES` |
| More email invitees than allowed (per user, 08 §4; counted for every email, whatever it turns out to be) | `429 RATE_LIMITED` — nothing created |
| Onboarding incomplete | `403 ONBOARDING_REQUIRED` |
| Other rate limits (06 §6) | `429 RATE_LIMITED` |

**Remembered options.** On success the input options are stored as
`users.settings.lastOptions[gameType]` and `lastGameType`. On create, omitted top-level option keys
are filled from `lastOptions[gameType]` (shallow merge: request keys win). If `resolveOptions`
rejects the merged input, the server retries once with the request input alone (module defaults for
the rest); only if that fails too is `INVALID_OPTIONS` returned, so a since-deleted upload or
disabled ruleset in the remembered choices never breaks game creation.

**Until email invites (alpha, M4).** Only an address that belongs to an onboarded account can be
played with: its invitation works as above. An email-invite seat (no account, or an account that
hasn't finished onboarding) is created and answered exactly the same (Q3), but nothing claims it
until onboarding claims exist (06 §6.4, M4), so it stays unfilled until the lobby is started
without it, cancelled or expires. Clients tell the creator that the other person must have signed
in first.

### `GET /api/v1/games/:id`
`200 { game: GameEnvelope, view: <module View> | null }`. `view` is `view(state, yourSeat)` while
active, null in the lobby (and for invitations), and `final_views.seats[yourSeat].view` for any
terminal status after start (`finished`; `declined` before a first action; `cancelled` by an
operator) — never the whole `final_views`. For an orphaned game (`available: false`, 02 §7.3)
`view` is null and the client shows "This game is no longer available". `404 NOT_FOUND` if the
viewer isn't a member (04 §Membership; never `403`).

### `GET /api/v1/games/:id/history`
Members only (`404` otherwise). Cursor-paginated, oldest first (`?cursor=`, 100 per page):
`{ items: [{ seq, seat, kind, record, describe: Text, via: "app" | "token" | "system", createdAt }], nextCursor }`
from `game_actions`. `via` lets every client mark AI moves (02 §9.1); `system` is a transition the
server made itself (a timeout). Never returns `action` or
`rng`. Empty for games that never started.

### `POST /api/v1/games/:id/actions`
`{ expectedVersion: number, action: <module Action> }`. Checks in order (first failure wins):

1. viewer is a member with a seat (`404 NOT_FOUND`);
2. status is `active` (`409 GAME_NOT_ACTIVE`) and the game isn't orphaned (`409 GAME_UNAVAILABLE`,
   02 §7.3);
3. `expectedVersion` matches (`409 STALE_GAME`) — before the turn check, so a stale client always
   learns it is stale;
4. viewer's seat is in `toAct` (`409 NOT_YOUR_TURN`);
5. for a bearer-token request on a **human** seat: the game's `aiAssistance` is `allowed`
   (`403 AI_NOT_ALLOWED`, 02 §9.3; also applied to resign, never to decline). The logged action
   gets `via = "token"`;
6. action schema (`400 INVALID_ACTION`);
7. for games using a `serverOnly` dictionary: the lookup budget (08 §4, 03 §10) is reserved for
   the action's worst case before the module runs (`429 RATE_LIMITED` without calling the module);
8. module `validate` (`400` with the module's `{ code, detail }`).

`200 { game, view, record, describe }`. The client refetches on `STALE_GAME` and `NOT_YOUR_TURN`.

### `POST /api/v1/games/:id/preview`
`{ action }` → `200 { preview }` or `400` module error, without committing. Only for modules that
implement `preview` (for any other game type the route answers `404 NOT_FOUND`), and only for a
full module `Action` (never free-form words). Runs checks 1, 2,
4, 6 and 7 of `/actions` — including the `serverOnly` lookup-budget reservation — then module
`preview`. It **never** runs check 5: previews are allowed to a `read` token whatever the game's
`aiAssistance` (02 §9.3). Rate-limited (it can be a dictionary oracle — 08 T22, §4); a test
asserts that preview draws on the lookup budget.

### Lifecycle transitions
All take `{ expectedVersion }` and are framework transitions (03 §5.2). Each answers
`200 { game, view }` as `GET /api/v1/games/:id` would after it, except a decline that ends the
caller's membership (a lobby decline, 04 §Membership), which answers `204`: there is nothing left
the caller may see.

| Method | Path | Who / when | Errors (besides `404`, `409 STALE_GAME`) |
|---|---|---|---|
| POST | `/api/v1/games/:id/start` | Creator, in `lobby`, with ≥ min joined → `active` (unfilled seats dropped; blocks re-checked, 02 §4) | `403 NOT_ALLOWED`, `409 WRONG_STATUS`, `409 NOT_ENOUGH_PLAYERS`, `409 INVALID_SEATS` (module `validateStart`) |
| POST | `/api/v1/games/:id/accept` | Holder of a user invitation (normal or hidden), in `lobby` → `joined`. If the accepter has a block in either direction with any joined member, the invitation becomes `declined` instead and the answer is `404` | `403 ONBOARDING_REQUIRED`, `409 WRONG_STATUS` |
| POST | `/api/v1/games/:id/decline` | Invited or joined non-creator in `lobby`, or any `playing` player — the creator included — before their first action (02 §4: ends the game `declined` if fewer than `min` would remain, else `out_reason = declined`) | `403 NOT_ALLOWED` (the creator in `lobby`: cancel instead), `409 ALREADY_ACTED`, `409 WRONG_STATUS` |
| POST | `/api/v1/games/:id/leave` | Joined non-creator, in `lobby` | `403 NOT_ALLOWED`, `409 WRONG_STATUS` |
| POST | `/api/v1/games/:id/remove-seat` | Creator, in `lobby`: `{ expectedVersion, playerId }` → that row becomes `removed` (`removed_at` set; an email seat's address is cleared). `playerId` must be a row of **this** game and not the creator's own. A remove never ends the lobby (02 §4) | `403 NOT_ALLOWED`, `404` (no such row in this game), `409 WRONG_STATUS` |
| POST | `/api/v1/games/:id/resign` | Any `playing` player, in `active` | `409 WRONG_STATUS` |
| POST | `/api/v1/games/:id/cancel` | Creator, in `lobby` → `cancelled` (realtime only, no push) | `403 NOT_ALLOWED`, `409 WRONG_STATUS` |

Email-invite seats have no user, so they can't decline through the API; the invitee ignores the
email (the seat expires with the lobby) or unsubscribes.

### Other game endpoints
These don't take `expectedVersion`.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/games/:id/join-link` | Creator, in `lobby`: create or rotate the join link → `{ url, expiresAt }` (the only time the URL is returned). Changes `join_links` only, not the game row. Errors: `403 NOT_ALLOWED`, `409 WRONG_STATUS`, `429` |
| DELETE | `/api/v1/games/:id/join-link` | Creator: revoke (body-less). Never ends the lobby (02 §4). `204`; `403 NOT_ALLOWED` |
| POST | `/api/v1/games/:id/seen` | `{ version }` — marks activity as read (not a transition). `204` |
| POST | `/api/v1/games/:id/add-player` | Creator of a `finished` game: `{ userId }` → records creator ↔ that link joiner as past opponents, if both acted and neither has blocked the other (02 §4, 06 §6.9). `204`; when a block exists in either direction it is a silent `204` no-op (no pair is written), so the creator can't learn about the block; `404` if not one of `canAddPlayers` |

### Join links
The token travels in the URL **fragment** (`PUBLIC_URL/join#<token>`), so it never reaches server
or proxy logs. The web page reads it and calls:

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/join/lookup` | `{ token }` → `200 { game: { id, gameType, options, resources, turnTimeoutDays, aiAssistance, creatorName, players (joined only: names, `kind`, `aiOwnerName`), openSeats } }` or `404` (invalid, revoked, expired, full, blocked with any member, the viewer declined/left this game, or was removed while this link was live — indistinguishable) |
| POST | `/api/v1/join` | `{ token }` → takes an open seat → `200 { game }`; same `404` cases; `409 ALREADY_JOINED`. Blocks are checked against **every** row in the game (`404` if any). If the viewer already holds a `normal` or `hidden` invitation in this game, joining accepts it instead of taking another seat (`joined_via = invitation`); an `inert` row is never accepted (its block makes the join `404` anyway). Server-side retries on version conflict (02 §4), so callers never see `STALE_GAME` |

Both return `403 ONBOARDING_REQUIRED` until onboarding is complete, and both are rate-limited per
user and per IP (08 §4); a link join counts only against the joiner's own limits, never the
creator's game caps. Joining always requires an explicit tap on Join (07 §1).

### Other
| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/players/recent` | Past opponents (04 `past_opponents`): `[{ userId, displayName, lastPlayedAt }]` up to 50, across all game types |
| GET | `/api/v1/games/types/:type/rules?version=` **public** | `200 { type, version, markdown }` from the installed manifest (02 §7.2); `404` for an unknown type or version |
| GET | `/api/v1/games/types/:type/schemas` **public** | JSON Schemas of the module's options, action, view, record and preview (§Versioning) |

## Catalog, config, health

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/config` **public** | `{ appName, appShortName, operatorContact, minAge, vapidPublicKey?, turnstileSiteKey?, uploadsEnabled }` — non-sensitive values only (`uploadsEnabled` = framework `DICTIONARY_UPLOADS`) |
| GET | `/api/v1/catalog` | `{ games: [{ type, version, name, description, icon, players, defaultTurnTimeoutDays, defaults, catalog }] }` for enabled game types (`name`, `description`, the sanitised `icon` and the overall `players` bounds come from the manifest, 02 §7.2, so the game picker needs no client chunk). `defaults` follows the create path's rule: the viewer's `lastOptions[type]` if `resolveOptions` accepts it against the current `ctx.resources`, otherwise `{}` (module defaults), so a deleted upload or disabled ruleset is never offered. `catalog` = module `catalog(ctx)` with `ctx.resources` = built-in and operator resources that are enabled (`DICTIONARIES_ENABLED`, `DICTIONARIES_EXTRA`) plus the **viewer's own** non-deleted uploads; it never contains `blob_key`, `sha256` or `size_bytes`, and no download URL (a game's word list is downloaded from its envelope's `resources[].downloadUrl`; nothing is previewed before a game exists, words §9.4). `icon` is SVG markup the server has sanitised; clients render it only as an image from a `data:` URL (`<img src="data:image/svg+xml,…">`), never inline in the page |
| GET | `/api/health` and `/api/v1/health` **public** | `200 { ok: true }` — no version or config details |
| GET | `/manifest.webmanifest` **public** | Generated from config (07 §4) |

## Dictionaries (bring-your-own, words §9.5)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/dictionaries/mine` | The viewer's uploads: `{ id, name, language, wordCount, createdAt, inUseByGames: number }` |
| POST | `/api/v1/dictionaries` | Streamed upload. Headers: `Content-Type: application/gzip`, `X-Dict-Name`, `X-Dict-Language` (both URL-encoded, validated), `X-Dict-Rights: attested`. Body: gzip of the normalised list. `201 { id, wordCount, skipped }`. Errors: `400 INVALID_DICTIONARY { detail: NOT_SORTED · BAD_CHARACTERS · TOO_MANY_WORDS · EMPTY · BAD_NAME }`, `413`, `409 TOO_MANY_DICTIONARIES` (quota, words §9.5), `403 NOT_ALLOWED` (account too new or uploads disabled), `503 UPLOADS_FULL` (instance-wide cap), `429`. Origin check applies; exempt from the JSON rule only. |
| DELETE | `/api/v1/dictionaries/:id` | Owner only (`404` otherwise). Soft delete; see lifecycle in words §9.5. |

No endpoint returns a `serverOnly` dictionary's contents, `blob_key`, `sha256`, or a download URL.

## Blocks

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/blocks` | The viewer's blocks: `[{ userId, displayName, createdAt }]` |
| POST | `/api/v1/blocks` | `{ userId }` — only a user who is a past opponent, or who holds or held any row (any state, including rows kept after start, 04) in a game where the viewer also has a row, can be blocked; otherwise `404`. Effects: deletes `past_opponents` rows both ways; in every shared `lobby`, if the viewer is the creator the other user's seat is removed, otherwise the viewer's own seat is declined (if invited) or left (if joined) — realtime only. `204` |
| DELETE | `/api/v1/blocks/:userId` | `204`; `404` if not the viewer's block |

## Push subscriptions

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/push/subscriptions` | `{ endpoint, keys: { p256dh, auth } }` (strict: `PushSubscription.toJSON()`'s `expirationTime` is not sent) — idempotent upsert bound to the current session; endpoint and keys validated per 08 T12, `400 BAD_REQUEST` if refused. An endpoint stored for another user or session moves only when the keys equal the stored ones; otherwise nothing changes, with the same `204` (04). `204` |
| DELETE | `/api/v1/push/subscriptions` | `{ endpoint }` — removes it if it belongs to the viewer; otherwise does nothing. `204` |

Both count toward "any authenticated write per user" (`LIMIT_WRITES_USER_MINUTE`, 08 §4). The
client takes the VAPID public key (`applicationServerKey`) from `GET /api/v1/config`'s
`vapidPublicKey`, which is absent when the instance sends no pushes (alpha A8).

## Email links (unsubscribe)

Every invite and nudge email links to `PUBLIC_URL/api/v1/email/unsubscribe?t=<token>`, and carries the
same URL in `List-Unsubscribe` with `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058).
The route lives under `/api/` so it is always server-handled: on Cloudflare it is covered by
`run_worker_first`, and the service worker's navigation fallback never serves the SPA shell for it
(03 §9, 07 §4). The token is `base64url(payload ‖ HMAC(K_unsub, payload))` with payload
`{ v: 1, purpose: "invites" | "nudges", emailId }`; it doesn't expire, and it never contains the
address. Concretely (alpha A6): the payload is the UTF-8 JSON text `{"v":1,"purpose":…,"emailId":…}`
and the MAC its raw 32 bytes, appended; a token is accepted only if it is unpadded base64url of at
most 512 characters, its MAC verifies (constant time), and its payload parses strictly to exactly
that shape (`emailId` 64 lower-case hex). Anything else is invalid, with no detail. A `nudges`
token finds the account by `users.email_id` (04); one that finds none (the account was deleted)
changes nothing and answers the same page.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/email/unsubscribe?t=` **public** | Server-rendered HTML page (`text/html`, shared security headers, `Cache-Control: no-store`) with a confirm button. **Never changes state.** Invalid token → the same page with a generic message |
| POST | `/api/v1/email/unsubscribe?t=` **public** | Form-encoded (`List-Unsubscribe=One-Click` per RFC 8058, or the page's button); the body isn't needed or read, the token is the authority. Adds the `emailId` to `email_suppressions` (`invites`; an existing row keeps its reason) or turns off email nudges for that user and clears `users.email_id` (`nudges`). Idempotent. Not rate-limited, deliberately (08 §4). Exempt from the Origin and JSON rules (mail clients post cross-origin). Always `200` with the same page: "done" for a valid token whatever it changed, the generic message for an invalid one |

## API tokens and AI accounts (06 §8, 02 §9) — session only

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/v1/me/tokens` | | `{ id, name, scopes, actsAs: { userId, displayName, kind }, createdAt, expiresAt, lastUsedAt }[]` for the viewer and their AI accounts; never the token or its hash |
| POST | `/api/v1/me/step-up/otp` | `{ purpose: "token_create" \| "token_admin" }` | `202` — emails a code for that purpose; the email names the action ("Code to create an API token", "Code to create an **admin** token") and uses a template distinct from sign-in (06 §7). Rate-limited separately from sign-in (08 §4) |
| POST | `/api/v1/me/tokens` | `{ name, scopes, expiresInDays, agentId?, code }` | `201 { id, token }` — the token is shown **once**. `code` must be a fresh code of purpose `token_create`, or `token_admin` when `scopes` is `["admin"]`. `scopes` is either a non-empty subset of `read`, `play`, `games:create`, `join` (with `read` always included), or exactly `["admin"]` (admins only, acting as themselves, never with other scopes, never for an agent). `expiresInDays`: 1–365, or 1–30 for `admin`. `agentId` must be one of the viewer's AI accounts; agent tokens may have only `read` and `play`. `name` follows the display-name rules (06 §5.1). Creating an `admin` token emails **every** admin and writes `admin_audit`. Errors: `400 INVALID_CODE`, `400 BAD_REQUEST`, `403 ONBOARDING_REQUIRED`, `409 TOO_MANY_TOKENS` (10 live per account) |
| DELETE | `/api/v1/me/tokens/:id` | (none) | `204`; revokes at once; `404` if not the viewer's or their agent's |
| GET | `/api/v1/me/agents` | | `{ id, displayName, createdAt, tokenCount }[]` |
| POST | `/api/v1/me/agents` | `{ displayName }` | `201 { id, displayName }`; display-name rules apply (06 §5.1); shown as "<owner>'s AI <name>" everywhere; counts toward the owner's rename budget (06 §5) and a daily creation limit (08 §4). `409 TOO_MANY_AGENTS` (3 live), `403 ONBOARDING_REQUIRED`, `429 RATE_LIMITED` |
| PATCH | `/api/v1/me/agents/:id` | `{ displayName }` | `200`; rename limit as for people (06 §5) |
| DELETE | `/api/v1/me/agents/:id` | (none) | `204`; runs account deletion for the agent (04 §Account deletion): its tokens are revoked and its active seats resign |

## Token scopes

Every route is listed here, with what may call it, including routes that aren't OpenAPI
operations (the WebSocket, the unsubscribe page, the manifest, the health routes and the dev-only
routes). The server enforces this table from the `x-scope` value on each OpenAPI operation
(§Versioning) and from the same table for the other routes. A route-enumeration test walks the
**final Hono router** (`app.routes`) of **both runtime builds** (Node and Worker, with every
runtime-specific route mounted) and fails if any registered route lacks an entry; at runtime a
route with no entry answers `403`: **deny by default**. "Session" means a cookie session only; a
token gets `403 INSUFFICIENT_SCOPE`. "Agent" says whether an AI account's token may call it
(otherwise `403 AGENT_NOT_ALLOWED`).

| Routes | Credential | Agent |
|---|---|---|
| `/api/health`, `/api/v1/health`, `/api/v1/config`, `/api/v1/openapi.json`, `/api/v1/games/types/:type/{rules,schemas}`, `/api/v1/auth/otp/*`, `/api/v1/email/unsubscribe` (GET page and POST), `/manifest.webmanifest` | public | — |
| `/__dev/*` (e.g. `/__dev/emails`) | public, **dev only**: registered only when `isLocalDev(config)` (06 §4), never in a production-config build (the enumeration test runs on production config and asserts they're absent) | — |
| `GET /api/v1/me`, `GET /api/v1/games`, `GET /api/v1/games/:id`, `GET /api/v1/games/:id/history`, `GET /api/v1/catalog`, `POST /api/v1/games/:id/preview` | session or `read` | yes |
| `POST /api/v1/games/:id/actions`, `…/resign`, `…/seen`, and `…/decline` by a `playing` seat before its first action | session or `play` (for seats the token's user already holds) | yes |
| `POST /api/v1/games`, `…/start`, `…/cancel`, `…/remove-seat`, `…/join-link` (POST/DELETE), `…/add-player`, `GET /api/v1/players/recent` | session or `games:create` (tokens: no email invitees) | no |
| `POST /api/v1/join/lookup`, `POST /api/v1/join`, `…/accept`, `…/leave`, and `…/decline` of a lobby invitation or lobby seat | session or `join` | no |
| `PATCH /api/v1/me`, `POST /api/v1/me/under-age`, `/api/v1/me/delete/otp`, `DELETE /api/v1/me`, `/api/v1/me/sessions*`, `/api/v1/me/tokens*`, `/api/v1/me/step-up/otp`, `/api/v1/me/agents*`, `/api/v1/auth/logout*`, `/api/v1/blocks*`, `/api/v1/push/*`, `/api/v1/dictionaries*` | session | no |
| `GET /api/v1/ws` | session (cookie) only; bearer tokens are rejected | no |
| `/api/v1/admin/*` | an `admin` token only (§Admin API) | no |

`read` is always part of a non-admin token. A token for an AI account acts as that agent, so its
view is the agent's seat's view; it stops working while the agent's owner isn't onboarded
(06 §8). The default scopes offered in the app are `read` + `play`; `games:create` and `join` are
opt-in and the app explains that an assistant should never need them.

## Admin API

Operators manage an instance through `/api/v1/admin/*`. Workers has no shell to log in to, so every
administrative task is an endpoint; the `pnpm admin:*` commands are thin clients of it (09 §1.2).

- **Who:** users whose email is listed in `ADMIN_EMAILS` (09). Not stored in the database; checked
  on every request.
- **How:** only a bearer token with the exclusive `admin` scope (06 §8: max 30 days, created with
  its own `token_admin` step-up code, every admin notified) belonging to a current admin. There is
  no cookie-based admin access in v1 (the web app has no admin screens). `@your-move/api-client`
  and `@your-move/mcp` refuse admin tokens unless explicitly told otherwise.
- **Non-admins** — any request without a valid admin token, including signed-in users and other
  tokens — get `404 NOT_FOUND` on every admin route, as if it didn't exist. The `/api/v1/admin/`
  prefix answers this `404` **before** any token validation, so a missing, expired, unknown or
  non-admin token all look the same (the global `401` for bad tokens never applies there). These refusals are
  logged and rate-limited per user and per IP bucket (08 §4), not written to `admin_audit`.
- Requests from admin principals — allowed or refused (e.g. validation errors) — are written to
  `admin_audit` (04) with a stable actor key, action, target and request id. Separate rate limits
  (08 §4).
- **Admins never see hidden game state** (no racks, bags, decks or other seats' views of an
  `active` game; the same secrecy rules as everyone, 04 invariant 4) and never browse email
  addresses: users are looked up only by an exact address (matched by its HMAC) or by id.
- The admin's `reason` text is stored in `admin_audit` only and **never shown to players**.
- Not part of the public OpenAPI document (§Versioning).

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/v1/admin/status` | | Instance status: version, enabled game types and installed packages, migration level, counts (users, active games, games by type and status, sessions), orphaned games (02 §7.3), sweep last-run times, email-provider health, rate-limit breaker state. No personal data |
| POST | `/api/v1/admin/users/lookup` | `{ email }` or `{ id }` | `200 { id, kind, displayName, createdAt, onboardedAt, suspendedAt, gameCounts, agentCount }` or `404`. The email is never echoed back |
| POST | `/api/v1/admin/users/:id/suspend` | `{ reason }` | `204`; sets `suspended_at`, revokes sessions and tokens (incl. its agents'), cancels the `lobby` games the user created and declines their pending invitations (realtime only); active games continue and time out normally. Sign-in is refused with the generic sign-in response (06 §3) — never revealing the suspension to someone who only knows the address; a signed-in client gets `403 SUSPENDED` |
| POST | `/api/v1/admin/users/:id/unsuspend` | `{}` | `204` |
| POST | `/api/v1/admin/users/:id/revoke-sessions` | `{ revokeTokens?: boolean }` | `204` |
| DELETE | `/api/v1/admin/users/:id` | `{ reason }` | `202`; runs account deletion (04) |
| POST | `/api/v1/admin/games/:id/cancel` | `{ reason }` | `204`; operator cancel (02 §4): a `lobby` game ends `cancelled`; an `active` (or orphaned) game ends `cancelled` with no ranking and players get a "cancelled by the operator" notice; `409 WRONG_STATUS` otherwise |
| GET | `/api/v1/admin/dictionaries` | `?source=builtin\|operator\|upload&cursor=` | Dictionaries with metadata (id, source, name, language, word count, created, owner id for uploads, games using it) — never contents, blob keys or hashes |
| POST | `/api/v1/admin/dictionaries` | streamed upload exactly as the user upload route: gzip body, metadata in headers `X-Dict-Id`, `X-Dict-Name`, `X-Dict-Language` | `201`; adds an **operator** dictionary, always `serverOnly` (09 §1), enabled at once; same validation pipeline (words §9.5). An id listed in `DICTIONARIES_EXTRA` but not yet added is reported by `status` |
| DELETE | `/api/v1/admin/dictionaries/:id` | `{ reason }` | `204`; for **any** operator dictionary or user upload (the takedown path, 08 T23): marked deleted, unusable for new games, purged once unreferenced (words §9.5) |
| GET | `/api/v1/admin/email-suppressions` | `?cursor=` | `{ emailId, reason, createdAt }[]` — HMACs only, never addresses |
| DELETE | `/api/v1/admin/email-suppressions` | `{ email }` | `204`; removes the suppression for that exact address (e.g. a user asked to receive invites again) |
| GET | `/api/v1/admin/audit` | `?cursor=` | `admin_audit` rows, newest first |

## Errors

Framework codes (reserved; modules can't use them, 02 §2.2):

| Status | Codes |
|---|---|
| 400 | `INVALID_CODE`, `INVALID_ACTION`, `INVALID_OPTIONS`, `INVALID_SEAT_COUNT` (seat count outside `players(options)`), `INVALID_TIMEOUT`, `INVALID_INVITEES`, `AI_SEATS_NOT_ALLOWED`, `CANNOT_PLAY_SELF`, `UNKNOWN_GAME`, `INVALID_DICTIONARY`, `BAD_REQUEST` |
| 401 | `UNAUTHENTICATED` |
| 403 | `BAD_ORIGIN`, `NOT_ALLOWED`, `ONBOARDING_REQUIRED`, `AI_NOT_ALLOWED`, `INSUFFICIENT_SCOPE` (token lacks the route's scope, or the route is session only, §Token scopes), `AGENT_NOT_ALLOWED` (an AI account's token on a route agents can't use), `SUSPENDED` |
| 404 | `NOT_FOUND` |
| 409 | `STALE_GAME`, `GAME_NOT_ACTIVE`, `GAME_UNAVAILABLE` (orphaned game, 02 §7.3), `NOT_YOUR_TURN`, `WRONG_STATUS`, `NOT_ENOUGH_PLAYERS`, `INVALID_SEATS` (module `validateStart` failed, at create or start), `ALREADY_ACTED`, `ALREADY_JOINED`, `TOO_MANY_GAMES`, `TOO_MANY_DICTIONARIES`, `TOO_MANY_TOKENS`, `TOO_MANY_AGENTS` |
| 413 / 415 | `TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL` — never carries detail; the log records a request id only, never inputs or state (09 §5) |
| 503 | `UPLOADS_FULL` |

Logs never contain request bodies or input-derived messages (09 §5). A request rejected with one
of the statuses that has a single code above (`400 BAD_REQUEST`, `401`, `404`, `413`, `415`,
`429`), such as a body over the limit, malformed JSON or a failed validation, keeps that status and
code and is logged below error level with the error's class and stack frames but not its message,
which can quote the input. Anything else is a server fault, answered `500 INTERNAL` and logged at
error level with class, message and stack: an error raised with a `5xx` status or with a status
whose code only the handler can choose (`403`, `409`), and a parse error in anything but the
request (stored JSON, an engine). The one exception to logging the message is a parse error
(`SyntaxError`): its message quotes the text being parsed, so it is logged at error level with its
class and stack frames only. Stack frames never include any line of the message, which can span
several lines.

**Module errors** from `validate` and `preview` are returned as `400 { error: { code, message,
detail } }` with the module's code and detail as-is. From `resolveOptions` and `validateStart` they
are wrapped: `400 INVALID_OPTIONS` / `409 INVALID_SEATS` with `detail: { code, detail }`.

`401 UNAUTHENTICATED` also covers an unknown, expired or revoked token (indistinguishable).

## WebSocket `GET /api/v1/ws`
- Cookie-authenticated only (bearer tokens are rejected); `Origin` MUST match `PUBLIC_URL` (else
  reject the upgrade with `403`).
  Per-IP upgrade rate limit (08 §4).
- Server → client messages (JSON): `game.created { gameId }`, `game.updated { gameId, version }`,
  `games.changed`. Sent only to members (04 §Membership). Keep-alive: client sends the literal text
  `ping`, server replies `pong` (auto-response on Cloudflare). Any other client message, or a
  message > 1 KiB, closes the socket.
- Close codes: `4000` max lifetime reached (reconnect), `4401` session revoked/invalid (go to
  sign-in), `4429` too many sockets.
- Max 5 concurrent sockets per user; oldest is closed (`4429`) when exceeded.
