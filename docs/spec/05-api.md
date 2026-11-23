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
- **Exemptions**, listed explicitly in code and nowhere else: the unsubscribe routes (§Email links)
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
| POST | `/api/auth/otp/verify` **public** | `{ email, code }` | `200 { user, needsOnboarding }` + `Set-Cookie`. `needsOnboarding` is true until a display name is set and the age attestation given (06 §5). Errors: `400 INVALID_CODE` (wrong, expired, consumed or unknown — indistinguishable), `429 RATE_LIMITED`. |
| POST | `/api/auth/logout` | `{}` | `204`, clears cookie, deletes session |
| POST | `/api/auth/logout-all` | `{}` | `204`, deletes all of the user's sessions |
| GET | `/api/me` | | `200 { id, email, displayName, settings, ageAttested }` or `401` |
| PATCH | `/api/me` | `{ displayName?, settings?, ageAttested?: true }` | `200` user. `settings` accepts only known keys (`emailNudges`, `whoCanAddMe`, theme). Game-creation actions return `403 ONBOARDING_REQUIRED` until onboarding is complete |
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
  turnTimeoutDays, seatOrder: "join" | "random",
  resources: [{ kind, id, name, distribution?, uploadedBy?: string }],  // e.g. the dictionary; never blob keys or hashes
  players: [{ seat: number | null /* null in lobby */, userId: string | null, displayName,
              state: "invited" | "joined" | "declined" | "left" | "removed" | "playing" | "out",
              outReason?: "eliminated" | "resigned" | "timed_out", rank?: number, score?: number,
              deadline?: number /* when this seat times out, if in toAct */, isYou: boolean, isCreator: boolean }],
  yourSeat: number | null, toAct: number[], yourTurn: boolean,
  yourInvitation: boolean,                   // you hold an `invited` seat (accept/decline)
  joinLink?: { active: boolean, expiresAt: number | null },  // creator only, lobby only; the URL is shown only on create/rotate
  createdAt, lastActionAt
}
GameSummary = { id, gameType, status, yourTurn, yourInvitation, players (names, states, ranks/scores),
  summary: { headline: Text, scores? },     // module summary(state, yourSeat), or the stored final summary
  lastAction: { describe: Text, byYou: boolean } | null,
  lastActionAt, unread: boolean, version }
```

`players[]` lists, in the lobby, rows in `invited` (with names only for user invitations; email
invites show "Invited by email"), `joined`, `declined`, `left` and `removed`; after start only
seated players. A player's own envelope never contains another user's email.

### `GET /api/games`
The viewer's games (membership as in 04), newest activity first: all `lobby`/`active`; `finished`
from the last 90 days; `declined`/`cancelled`/`expired` from the last 7 days. Cursor-paginated
(`?cursor=`, 50 per page; `nextCursor`). Filters: `?status=`, `?gameType=`, `?invitations=true`.

### `POST /api/games`
```ts
{
  gameType: string,
  options?: unknown,               // module input; omitted fields default from users.settings.lastOptions[gameType], then module defaults (resolveOptions)
  seats?: number,                  // default: max if min = max, else min; must be within players(options)
  turnTimeoutDays?: number,        // integer 1–30; default module defaultTurnTimeoutDays(options)
  seatOrder?: "join" | "random",   // default "join"
  invitees: ({ email: string } | { userId: string })[],   // 0..seats-1
  invite?: boolean,                // consent to email non-users (see below)
  joinLink?: boolean               // create a join link for remaining open seats
}
```

| Case | Response |
|---|---|
| Created | `201 { game: GameEnvelope, joinLinkUrl?: string }` — `active` immediately if every seat is filled by auto-joined users, else `lobby` |
| Any invitee email has no account and `invite` is absent/false | `404 NOT_A_PLAYER { emails: string[], canInvite: true }` — nothing created |
| `invite: true` | non-users get email-invite seats and an invite email (unless suppressed / over per-target limit — response identical, see 06 §6) |
| Existing users | auto-joined or given an invitation per their `whoCanAddMe` (06 §6.2); over the target's inbound cap the invitation is silently `suppressed` — response identical |
| Unknown/disabled `gameType` | `400 UNKNOWN_GAME` |
| `resolveOptions` fails (incl. a resource the creator may not use) | `400 INVALID_OPTIONS { detail: { code, detail? } }` with the module code, e.g. `UNKNOWN_DICTIONARY`, `INCOMPATIBLE_DICTIONARY` |
| `seats` outside range, or `turnTimeoutDays` not an integer 1–30 | `400 INVALID_SEATS` / `400 INVALID_TIMEOUT` |
| More invitees than `seats - 1`, duplicates, or a `userId` that isn't a past opponent | `400 INVALID_INVITEES` |
| Self | `400 CANNOT_PLAY_SELF` |
| Any invitee blocks or is blocked by the creator | `403 CANNOT_CHALLENGE` (same for both directions; doesn't say which invitee) |
| Creator has too many non-finished games they created (per pair > 5, total > 50) — counts only games the **creator** created | `409 TOO_MANY_GAMES` |
| Onboarding incomplete | `403 ONBOARDING_REQUIRED` |
| Rate limits (06 §6) | `429 RATE_LIMITED` |

On success the input options are stored as `users.settings.lastOptions[gameType]` and
`lastGameType`.

### `GET /api/games/:id`
`200 { game: GameEnvelope, view: <module View> | null }`. `view` is `view(state, yourSeat)` while
active, null in the lobby (and for invitations), and `final_views.seats[yourSeat].view` when
finished — never the whole `final_views`. `404 NOT_FOUND` if the viewer isn't a member (04
§Membership; never `403`).

### `POST /api/games/:id/actions`
`{ expectedVersion: number, action: <module Action> }`. Checks in order (first failure wins):

1. viewer is a member with a seat (`404 NOT_FOUND`);
2. status is `active` (`409 GAME_NOT_ACTIVE`);
3. `expectedVersion` matches (`409 STALE_GAME`) — before the turn check, so a stale client always
   learns it is stale;
4. viewer's seat is in `toAct` (`409 NOT_YOUR_TURN`);
5. action schema (`400 INVALID_ACTION`);
6. module `validate` (`400` with the module's `{ code, detail }`).

`200 { game, view, record, describe }`. The client refetches on `STALE_GAME` and `NOT_YOUR_TURN`.

### `POST /api/games/:id/preview`
`{ action }` → `200 { preview }` or `400` module error, without committing. Only for modules that
implement `preview`, and only for a full module `Action` (never free-form words). Checks 1, 2, 4,
5, then module `preview`. Rate-limited (it can be a dictionary oracle — 08 T22, §4).

### Lifecycle endpoints
All take `{ expectedVersion }` and are framework transitions (03 §5.2).

| Method | Path | Who / when | Errors (besides `404`, `409 STALE_GAME`) |
|---|---|---|---|
| POST | `/api/games/:id/start` | Creator, in `lobby`, with ≥ min joined → `active` (unfilled seats dropped) | `403 NOT_ALLOWED`, `409 WRONG_STATUS`, `409 NOT_ENOUGH_PLAYERS`, `409 INVALID_SEATS` (module `validateStart`) |
| POST | `/api/games/:id/accept` | Holder of a user invitation, in `lobby` → `joined` | `409 WRONG_STATUS` |
| POST | `/api/games/:id/decline` | Invited or joined non-creator in `lobby`, or a `playing` player before their first action (02 §4) | `403 NOT_ALLOWED` (creator), `409 ALREADY_ACTED`, `409 WRONG_STATUS` |
| POST | `/api/games/:id/leave` | Joined non-creator, in `lobby` | `403 NOT_ALLOWED`, `409 WRONG_STATUS` |
| POST | `/api/games/:id/remove-seat` | Creator, in `lobby`: `{ expectedVersion, playerId }` → that row becomes `removed` (an email-invite seat's address is cleared) | `403 NOT_ALLOWED`, `409 WRONG_STATUS` |
| POST | `/api/games/:id/resign` | Any `playing` player, in `active` | `409 WRONG_STATUS` |
| POST | `/api/games/:id/cancel` | Creator, in `lobby` → `cancelled` | `403 NOT_ALLOWED`, `409 WRONG_STATUS` |
| POST | `/api/games/:id/join-link` | Creator, in `lobby`: create or rotate the join link → `{ url, expiresAt }` (the only time the URL is returned) | `403 NOT_ALLOWED`, `409 WRONG_STATUS`, `429` |
| DELETE | `/api/games/:id/join-link` | Creator: revoke | `403 NOT_ALLOWED` |
| POST | `/api/games/:id/seen` | `{ version }` — marks activity as read (not a transition) | |

Email-invite seats have no user, so they can't decline through the API; the invitee ignores the
email (the seat expires with the lobby) or unsubscribes.

### Join links
The token travels in the URL **fragment** (`PUBLIC_URL/join#<token>`), so it never reaches server
or proxy logs. The web page reads it and calls:

| Method | Path | Notes |
|---|---|---|
| POST | `/api/join/lookup` | `{ token }` → `200 { game: { id, gameType, options, resources, turnTimeoutDays, creatorName, players (names only), openSeats } }` or `404` (invalid, revoked, expired, full, blocked with any member, or the viewer declined/left/was removed — indistinguishable) |
| POST | `/api/join` | `{ token }` → takes an open seat → `200 { game }`; same `404` cases; `409 ALREADY_JOINED`. Server-side retries on version conflict (02 §4), so callers never see `STALE_GAME` |

Both are rate-limited per user and per IP (08 §4). Joining always requires an explicit tap on Join
(07 §1).

### Other
| Method | Path | Notes |
|---|---|---|
| GET | `/api/players/recent` | Past opponents (04 `past_opponents`): `[{ userId, displayName, lastPlayedAt }]` up to 50, across all game types |

## Catalog, config, health

| Method | Path | Notes |
|---|---|---|
| GET | `/api/config` **public** | `{ appName, appShortName, operatorContact, minAge, vapidPublicKey?, turnstileSiteKey?, uploadsEnabled }` — non-sensitive values only |
| GET | `/api/catalog` | `{ games: [{ type, version, name, players, defaultTurnTimeoutDays, defaults, catalog }] }` for enabled game types. `defaults` = the viewer's `lastOptions[type]`. `catalog` = module `catalog(ctx)` with `ctx.resources` = built-in and operator resources that are enabled plus the **viewer's own** non-deleted uploads; it never contains `blob_key`, `sha256` or `size_bytes`. Public dictionaries carry their versioned, hashed download URL |
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
| POST | `/api/blocks` | `{ userId }` — only a user who is a past opponent, or shares a game (any state) with the viewer, can be blocked; otherwise `404`. Also deletes `past_opponents` rows both ways and declines any lobby invitation between them. `204` |
| DELETE | `/api/blocks/:userId` | `204`; `404` if not the viewer's block |

## Push subscriptions

| Method | Path | Notes |
|---|---|---|
| POST | `/api/push/subscriptions` | `{ endpoint, keys: { p256dh, auth } }` — idempotent upsert bound to the current session; endpoint and keys validated per 08 T12. `204` |
| DELETE | `/api/push/subscriptions` | `{ endpoint }` — removes it if it belongs to the viewer. `204` |

## Email links (unsubscribe)

Every invite and nudge email links to `PUBLIC_URL/unsubscribe?t=<token>`. The token is
`base64url(payload ‖ HMAC(K_unsub, payload))` with payload `{ v: 1, purpose: "invites" | "nudges",
emailId }`; it doesn't expire, and it never contains the address.

| Method | Path | Notes |
|---|---|---|
| GET | `/unsubscribe?t=` **public** | Server-rendered page with a confirm button. **Never changes state.** Invalid token → the same page with a generic message |
| POST | `/unsubscribe?t=` **public** | Form-encoded (`List-Unsubscribe=One-Click` per RFC 8058, or the page's button). Adds the `emailId` to `email_suppressions` (`invites`) or turns off email nudges for that user (`nudges`). Exempt from the Origin and JSON rules (mail clients post cross-origin). Always `200` with the same page |

## Errors

Framework codes (reserved; modules can't use them, 02 §2.2):

| Status | Codes |
|---|---|
| 400 | `INVALID_CODE`, `INVALID_ACTION`, `INVALID_OPTIONS`, `INVALID_SEATS`, `INVALID_TIMEOUT`, `INVALID_INVITEES`, `CANNOT_PLAY_SELF`, `UNKNOWN_GAME`, `INVALID_DICTIONARY`, `BAD_REQUEST` |
| 401 | `UNAUTHENTICATED` |
| 403 | `BAD_ORIGIN`, `NOT_ALLOWED`, `CANNOT_CHALLENGE`, `ONBOARDING_REQUIRED` |
| 404 | `NOT_FOUND`, `NOT_A_PLAYER` |
| 409 | `STALE_GAME`, `GAME_NOT_ACTIVE`, `NOT_YOUR_TURN`, `WRONG_STATUS`, `NOT_ENOUGH_PLAYERS`, `ALREADY_ACTED`, `ALREADY_JOINED`, `TOO_MANY_GAMES`, `TOO_MANY_DICTIONARIES` |
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
