# 05 — API

Same-origin JSON API under `/api`. All request/response bodies are defined as Zod schemas in
`packages/shared` and used by both server (validation) and client (typing). Unknown fields are
rejected (`.strict()`).

## Conventions

- Auth: session cookie (see 06). Endpoints are authenticated unless marked **public**.
- State-changing requests (`POST`/`PATCH`/`DELETE`) MUST carry an `Origin` header equal to
  `PUBLIC_URL`'s origin, else `403 BAD_ORIGIN` (CSRF defence, 08). Requests **with a body** MUST be
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
| POST | `/api/auth/otp/request` **public** | `{ email }` | `202 {}` — always identical regardless of whether the email is known, rate-limited, or suppressed. Rate limiting is reported only when the *IP* is limited (`429 RATE_LIMITED`), never per email. |
| POST | `/api/auth/otp/verify` **public** | `{ email, code }` | `200 { user, needsOnboarding }` + `Set-Cookie`. `needsOnboarding` is true until a display name is set and the age confirmation given for the current `MIN_AGE` (06 §5). Errors: `400 INVALID_CODE` (wrong, expired, consumed or unknown — indistinguishable), `429 RATE_LIMITED`. |
| POST | `/api/auth/logout` | `{}` | `204`, clears cookie, deletes session |
| POST | `/api/auth/logout-all` | `{}` | `204`, deletes all of the user's sessions |
| GET | `/api/me` | | `200 { id, email, displayName, settings, ageAttested }` or `401` |
| PATCH | `/api/me` | `{ displayName?, settings?, ageAttested?: true }` | `200` user. `settings` accepts only known keys (`emailNudges`, `whoCanAddMe`, theme). The request that completes onboarding sets `onboarded_at` and claims email-invite seats (06 §6.4). Display-name changes after onboarding: at most 3 per 30 days (`429 RATE_LIMITED`), each logged (06 §5) |
| POST | `/api/me/under-age` | `{}` | Only while onboarding is incomplete: deletes the just-created account and its session at once (06 §5, 04 §Account deletion). `204`, clears cookie; `409 WRONG_STATUS` once onboarded |
| POST | `/api/me/delete/otp` | `{}` | `202` — emails a `delete_account`-purpose code (06 §7) |
| DELETE | `/api/me` | `{ code }` | `204` if the code is a valid `delete_account` code; else `400 INVALID_CODE` |
| GET | `/api/me/sessions` | | list of `{ id, createdAt, lastSeenAt, userAgent, current }` |
| DELETE | `/api/me/sessions/:id` | (none) | `204`; `404` if not one of the viewer's sessions |

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
  resources: [{ kind, id, name, distribution?, uploadedBy?: string,
                downloadUrl?: string /* public distribution only: versioned, hashed (words §9.4) */ }],  // never blob keys or hashes
  players: [{ playerId?: string /* game_players.id; creator only, lobby only (for remove-seat) */,
              seat: number | null /* null in lobby */, userId: string | null, displayName: string | null,
              invitedAs?: string /* the address the creator typed; creator only, until accepted */,
              state: "invited" | "joined" | "declined" | "left" | "removed" | "playing" | "out",
              outReason?: "eliminated" | "resigned" | "timed_out" | "declined", rank?: number, score?: number,
              deadline?: number /* when this seat times out, if in toAct */, isYou: boolean, isCreator: boolean }],
  yourSeat: number | null, toAct: number[], yourTurn: boolean,
  yourInvitation: boolean,                   // you hold an `invited` seat (accept/decline)
  joinLink?: { active: boolean, expiresAt: number | null },  // creator only, lobby only; the URL is shown only on create/rotate
  canAddPlayers?: { userId, displayName }[], // creator only, finished games: link joiners who acted and aren't yet past opponents (02 §4)
  createdAt, lastActionAt
}
GameSummary = { id, gameType, status, endReason, yourTurn, yourInvitation, players (as in the envelope),
  summary: { headline: Text, scores? },     // module summary(state, yourSeat) while active; the stored final summary after start;
                                            // in the lobby a framework Text, e.g. "Waiting for 2 players"
  lastAction: { describe: Text, byYou: boolean } | null,
  lastActionAt, unread: boolean, version }
```

**Who sees what in `players[]`.** In the lobby: rows in `invited`, `joined`, `declined`, `left` and
`removed`. An `invited` row has `displayName: null` and `userId: null` for everyone until it is
accepted: the creator sees `invitedAs` (the address they typed) or "Invited" for a past opponent
picked from the list; other members see only "Invited". `normal`, `hidden` and `inert` invitations
look identical (Q3, 04). Link joiners (and the join lookup) see only `joined` rows. After start:
only seated players. A player's envelope never contains an email other than the creator's own typed
`invitedAs` values.

### `GET /api/games`
The viewer's games (membership as in 04), newest activity first: all `lobby`/`active`; `finished`
from the last 90 days; `declined`/`cancelled`/`expired` from the last 7 days. Cursor-paginated
(`?cursor=`, 50 per page; `nextCursor`). Filters: `?status=`, `?gameType=`, `?invitations=true`
(normal invitations), `?invitations=hidden` (the collapsed *Hidden invitations*, 06 §6.7).
`403 ONBOARDING_REQUIRED` until onboarding is complete.

### `POST /api/games`
```ts
{
  gameType: string,
  options?: unknown,               // module input, see "Remembered options" below
  seats?: number,                  // default: max if min = max, else min; must be within players(options)
  turnTimeoutDays?: number,        // integer 1–30; default module defaultTurnTimeoutDays(options)
  seatOrder?: "join" | "random",   // default "join"
  invitees: ({ email: string } | { userId: string })[],   // 0..seats-1; userId must be a past opponent
  joinLink?: boolean               // create a join link for remaining open seats
}
```

**Email invitees never reveal whether an address has an account** (06 §6.1, Q3). Every valid email
gets a seat and the response is the same whether the address belongs to an onboarded user (who gets
an invitation), to nobody or to an un-onboarded account (email-invite seat), is on the suppression
list or over an invite cap (seat created, no email sent), or belongs to someone with a block in
either direction with the creator or another invitee (an `inert` seat that is never delivered). The
work done and the response time are the same in every case (06 §3.2 approach: same reads and writes,
emails sent via `waitUntil`).

| Case | Response |
|---|---|
| Created | `201 { game: GameEnvelope, joinLinkUrl?: string }` — `active` immediately if every seat is filled by auto-joined past opponents (and no join link was requested), else `lobby` |
| Unknown/disabled `gameType` | `400 UNKNOWN_GAME` |
| `resolveOptions` fails (incl. a resource the creator may not use, 02 §2.1 rule 7) | `400 INVALID_OPTIONS { detail: { code, detail? } }` with the module code, e.g. `UNKNOWN_DICTIONARY`, `INCOMPATIBLE_DICTIONARY` |
| `seats` outside `players(options)` | `400 INVALID_SEAT_COUNT` |
| `turnTimeoutDays` not an integer 1–30 | `400 INVALID_TIMEOUT` |
| `validateStart(options, seats)` fails | `409 INVALID_SEATS { detail: { code, detail? } }` — nothing created |
| More invitees than `seats - 1`, duplicates, an invalid address, or a `userId` that isn't a past opponent | `400 INVALID_INVITEES` |
| The creator's own email or id | `400 CANNOT_PLAY_SELF` |
| Creator has too many non-finished games they created (per pair > 5, total > 50) — counts only games the **creator** created | `409 TOO_MANY_GAMES` |
| More email invitees than allowed (per user, 08 §4; counted for every email, whatever it turns out to be) | `429 RATE_LIMITED` — nothing created |
| Onboarding incomplete | `403 ONBOARDING_REQUIRED` |
| Other rate limits (06 §6) | `429 RATE_LIMITED` |

**Remembered options.** On success the input options are stored as
`users.settings.lastOptions[gameType]` and `lastGameType`. On create, omitted top-level option keys
are filled from `lastOptions[gameType]` (shallow merge: request keys win). If `resolveOptions`
rejects the merged input, the server retries once with the request input alone (module defaults for
the rest); only if that fails too is `INVALID_OPTIONS` returned, so a since-deleted upload or
disabled ruleset in the remembered choices never breaks game creation.

### `GET /api/games/:id`
`200 { game: GameEnvelope, view: <module View> | null }`. `view` is `view(state, yourSeat)` while
active, null in the lobby (and for invitations), and `final_views.seats[yourSeat].view` for any
terminal status after start (`finished`, or `declined` before a first action) — never the whole
`final_views`. `404 NOT_FOUND` if the viewer isn't a member (04 §Membership; never `403`).

### `GET /api/games/:id/history`
Members only (`404` otherwise). Cursor-paginated, oldest first (`?cursor=`, 100 per page):
`{ items: [{ seq, seat, kind, record, describe: Text, createdAt }], nextCursor }` from
`game_actions`. Never returns `action` or `rng`. Empty for games that never started.

### `POST /api/games/:id/actions`
`{ expectedVersion: number, action: <module Action> }`. Checks in order (first failure wins):

1. viewer is a member with a seat (`404 NOT_FOUND`);
2. status is `active` (`409 GAME_NOT_ACTIVE`);
3. `expectedVersion` matches (`409 STALE_GAME`) — before the turn check, so a stale client always
   learns it is stale;
4. viewer's seat is in `toAct` (`409 NOT_YOUR_TURN`);
5. action schema (`400 INVALID_ACTION`);
6. for games using a `serverOnly` dictionary: the lookup budget (08 §4, 03 §10) is reserved for
   the action's worst case before the module runs (`429 RATE_LIMITED` without calling the module);
7. module `validate` (`400` with the module's `{ code, detail }`).

`200 { game, view, record, describe }`. The client refetches on `STALE_GAME` and `NOT_YOUR_TURN`.

### `POST /api/games/:id/preview`
`{ action }` → `200 { preview }` or `400` module error, without committing. Only for modules that
implement `preview`, and only for a full module `Action` (never free-form words). Checks 1, 2, 4,
5, 6, then module `preview`. Rate-limited (it can be a dictionary oracle — 08 T22, §4).

### Lifecycle transitions
All take `{ expectedVersion }` and are framework transitions (03 §5.2).

| Method | Path | Who / when | Errors (besides `404`, `409 STALE_GAME`) |
|---|---|---|---|
| POST | `/api/games/:id/start` | Creator, in `lobby`, with ≥ min joined → `active` (unfilled seats dropped; blocks re-checked, 02 §4) | `403 NOT_ALLOWED`, `409 WRONG_STATUS`, `409 NOT_ENOUGH_PLAYERS`, `409 INVALID_SEATS` (module `validateStart`) |
| POST | `/api/games/:id/accept` | Holder of a user invitation (normal or hidden), in `lobby` → `joined`. If the accepter has a block in either direction with any joined member, the invitation becomes `declined` instead and the answer is `404` | `403 ONBOARDING_REQUIRED`, `409 WRONG_STATUS` |
| POST | `/api/games/:id/decline` | Invited or joined non-creator in `lobby`, or a `playing` player before their first action (02 §4: ends the game `declined` if fewer than `min` would remain, else `out_reason = declined`) | `403 NOT_ALLOWED` (creator), `409 ALREADY_ACTED`, `409 WRONG_STATUS` |
| POST | `/api/games/:id/leave` | Joined non-creator, in `lobby` | `403 NOT_ALLOWED`, `409 WRONG_STATUS` |
| POST | `/api/games/:id/remove-seat` | Creator, in `lobby`: `{ expectedVersion, playerId }` → that row becomes `removed` (`removed_at` set; an email seat's address is cleared). `playerId` must be a row of **this** game and not the creator's own | `403 NOT_ALLOWED`, `404` (no such row in this game), `409 WRONG_STATUS` |
| POST | `/api/games/:id/resign` | Any `playing` player, in `active` | `409 WRONG_STATUS` |
| POST | `/api/games/:id/cancel` | Creator, in `lobby` → `cancelled` (realtime only, no push) | `403 NOT_ALLOWED`, `409 WRONG_STATUS` |

Email-invite seats have no user, so they can't decline through the API; the invitee ignores the
email (the seat expires with the lobby) or unsubscribes.

### Other game endpoints
These don't take `expectedVersion`.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/games/:id/join-link` | Creator, in `lobby`: create or rotate the join link → `{ url, expiresAt }` (the only time the URL is returned). Changes `join_links` only, not the game row. Errors: `403 NOT_ALLOWED`, `409 WRONG_STATUS`, `429` |
| DELETE | `/api/games/:id/join-link` | Creator: revoke (body-less). Never ends the lobby (02 §4). `204`; `403 NOT_ALLOWED` |
| POST | `/api/games/:id/seen` | `{ version }` — marks activity as read (not a transition). `204` |
| POST | `/api/games/:id/add-player` | Creator of a `finished` game: `{ userId }` → records creator ↔ that link joiner as past opponents, if both acted (02 §4, 06 §6.9). `204`; `404` if not one of `canAddPlayers` |

### Join links
The token travels in the URL **fragment** (`PUBLIC_URL/join#<token>`), so it never reaches server
or proxy logs. The web page reads it and calls:

| Method | Path | Notes |
|---|---|---|
| POST | `/api/join/lookup` | `{ token }` → `200 { game: { id, gameType, options, resources, turnTimeoutDays, creatorName, players (joined only, names only), openSeats } }` or `404` (invalid, revoked, expired, full, blocked with any member, the viewer declined/left this game, or was removed while this link was live — indistinguishable) |
| POST | `/api/join` | `{ token }` → takes an open seat → `200 { game }`; same `404` cases; `409 ALREADY_JOINED`. If the viewer already holds an invitation in this game (of any delivery), joining accepts it instead of taking another seat. Server-side retries on version conflict (02 §4), so callers never see `STALE_GAME` |

Both return `403 ONBOARDING_REQUIRED` until onboarding is complete, and both are rate-limited per
user and per IP (08 §4); a link join counts only against the joiner's own limits, never the
creator's game caps. Joining always requires an explicit tap on Join (07 §1).

### Other
| Method | Path | Notes |
|---|---|---|
| GET | `/api/players/recent` | Past opponents (04 `past_opponents`): `[{ userId, displayName, lastPlayedAt }]` up to 50, across all game types |

## Catalog, config, health

| Method | Path | Notes |
|---|---|---|
| GET | `/api/config` **public** | `{ appName, appShortName, operatorContact, minAge, vapidPublicKey?, turnstileSiteKey?, uploadsEnabled }` — non-sensitive values only (`uploadsEnabled` = framework `DICTIONARY_UPLOADS`) |
| GET | `/api/catalog` | `{ games: [{ type, version, name, players, defaultTurnTimeoutDays, defaults, catalog }] }` for enabled game types. `defaults` = the viewer's `lastOptions[type]` with any key dropped that `resolveOptions` rejects against the current `ctx.resources` (so a deleted upload or disabled ruleset is never offered). `catalog` = module `catalog(ctx)` with `ctx.resources` = built-in and operator resources that are enabled (`DICTIONARIES_ENABLED`, `DICTIONARIES_EXTRA`) plus the **viewer's own** non-deleted uploads; it never contains `blob_key`, `sha256` or `size_bytes`. Public dictionaries carry their versioned, hashed download URL |
| GET | `/api/health` **public** | `200 { ok: true }` — no version or config details |
| GET | `/manifest.webmanifest` **public** | Generated from config (07 §4) |

## Dictionaries (bring-your-own, words §9.5)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/dictionaries/mine` | The viewer's uploads: `{ id, name, language, wordCount, createdAt, inUseByGames: number }` |
| POST | `/api/dictionaries` | Streamed upload. Headers: `Content-Type: application/gzip`, `X-Dict-Name`, `X-Dict-Language` (both URL-encoded, validated), `X-Dict-Rights: attested`. Body: gzip of the normalised list. `201 { id, wordCount, skipped }`. Errors: `400 INVALID_DICTIONARY { detail: NOT_SORTED · BAD_CHARACTERS · TOO_MANY_WORDS · EMPTY · BAD_NAME }`, `413`, `409 TOO_MANY_DICTIONARIES` (quota, words §9.5), `403 NOT_ALLOWED` (account too new or uploads disabled), `503 UPLOADS_FULL` (instance-wide cap), `429`. Origin check applies; exempt from the JSON rule only. |
| DELETE | `/api/dictionaries/:id` | Owner only (`404` otherwise). Soft delete; see lifecycle in words §9.5. |

No endpoint returns a `serverOnly` dictionary's contents, `blob_key`, `sha256`, or a download URL.

## Blocks

| Method | Path | Notes |
|---|---|---|
| GET | `/api/blocks` | The viewer's blocks: `[{ userId, displayName, createdAt }]` |
| POST | `/api/blocks` | `{ userId }` — only a user who is a past opponent, or who holds or held any row (any state, including rows kept after start, 04) in a game where the viewer also has a row, can be blocked; otherwise `404`. Effects: deletes `past_opponents` rows both ways; in every shared `lobby`, if the viewer is the creator the other user's seat is removed, otherwise the viewer's own seat is declined (if invited) or left (if joined) — realtime only. `204` |
| DELETE | `/api/blocks/:userId` | `204`; `404` if not the viewer's block |

## Push subscriptions

| Method | Path | Notes |
|---|---|---|
| POST | `/api/push/subscriptions` | `{ endpoint, keys: { p256dh, auth } }` — idempotent upsert bound to the current session; endpoint and keys validated per 08 T12. `204` |
| DELETE | `/api/push/subscriptions` | `{ endpoint }` — removes it if it belongs to the viewer. `204` |

## Email links (unsubscribe)

Every invite and nudge email links to `PUBLIC_URL/api/email/unsubscribe?t=<token>`, and carries the
same URL in `List-Unsubscribe` with `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058).
The route lives under `/api/` so it is always server-handled: on Cloudflare it is covered by
`run_worker_first`, and the service worker's navigation fallback never serves the SPA shell for it
(03 §9, 07 §4). The token is `base64url(payload ‖ HMAC(K_unsub, payload))` with payload
`{ v: 1, purpose: "invites" | "nudges", emailId }`; it doesn't expire, and it never contains the
address.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/email/unsubscribe?t=` **public** | Server-rendered HTML page (`text/html`, shared security headers, `Cache-Control: no-store`) with a confirm button. **Never changes state.** Invalid token → the same page with a generic message |
| POST | `/api/email/unsubscribe?t=` **public** | Form-encoded (`List-Unsubscribe=One-Click` per RFC 8058, or the page's button). Adds the `emailId` to `email_suppressions` (`invites`) or turns off email nudges for that user (`nudges`). Exempt from the Origin and JSON rules (mail clients post cross-origin). Always `200` with the same page |

## Errors

Framework codes (reserved; modules can't use them, 02 §2.2):

| Status | Codes |
|---|---|
| 400 | `INVALID_CODE`, `INVALID_ACTION`, `INVALID_OPTIONS`, `INVALID_SEAT_COUNT` (seat count outside `players(options)`), `INVALID_TIMEOUT`, `INVALID_INVITEES`, `CANNOT_PLAY_SELF`, `UNKNOWN_GAME`, `INVALID_DICTIONARY`, `BAD_REQUEST` |
| 401 | `UNAUTHENTICATED` |
| 403 | `BAD_ORIGIN`, `NOT_ALLOWED`, `ONBOARDING_REQUIRED` |
| 404 | `NOT_FOUND` |
| 409 | `STALE_GAME`, `GAME_NOT_ACTIVE`, `NOT_YOUR_TURN`, `WRONG_STATUS`, `NOT_ENOUGH_PLAYERS`, `INVALID_SEATS` (module `validateStart` failed, at create or start), `ALREADY_ACTED`, `ALREADY_JOINED`, `TOO_MANY_GAMES`, `TOO_MANY_DICTIONARIES` |
| 413 / 415 | `TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL` — never carries detail; the log records a request id only, never inputs or state (09 §5) |
| 503 | `UPLOADS_FULL` |

**Module errors** from `validate` and `preview` are returned as `400 { error: { code, message,
detail } }` with the module's code and detail as-is. From `resolveOptions` and `validateStart` they
are wrapped: `400 INVALID_OPTIONS` / `409 INVALID_SEATS` with `detail: { code, detail }`.

## WebSocket `GET /api/ws`
- Cookie-authenticated; `Origin` MUST match `PUBLIC_URL` (else reject the upgrade with `403`).
  Per-IP upgrade rate limit (08 §4).
- Server → client messages (JSON): `game.created { gameId }`, `game.updated { gameId, version }`,
  `games.changed`. Sent only to members (04 §Membership). Keep-alive: client sends the literal text
  `ping`, server replies `pong` (auto-response on Cloudflare). Any other client message, or a
  message > 1 KiB, closes the socket.
- Close codes: `4000` max lifetime reached (reconnect), `4401` session revoked/invalid (go to
  sign-in), `4429` too many sockets.
- Max 5 concurrent sockets per user; oldest is closed (`4429`) when exceeded.
