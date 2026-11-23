# 04 — Data model

SQLite dialect (D1 and better-sqlite3). Defined once in Drizzle (`packages/server/src/db/schema.ts`)
with generated SQL migrations in `packages/server/migrations/`, applied by `wrangler d1 migrations
apply` on Cloudflare and by the Node runtime on startup.

Conventions:

- IDs: `TEXT` UUIDv4 from `crypto.randomUUID()`.
- Timestamps: `INTEGER` milliseconds since epoch (UTC).
- JSON columns: `TEXT` containing JSON, parsed and validated by Zod on read.
- Emails are stored **normalised**: trimmed, Unicode NFC, lower-cased. No provider-specific
  canonicalisation (dots / `+tags` are kept as typed). Must match a pragmatic address regex and be
  ≤ 254 chars.
- Columns marked 🔒 are **secret game state** and must never be serialised to a client (02 §2.1
  rule 4, invariant 4 below).

## Tables

### `users`
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| kind | TEXT NOT NULL DEFAULT 'human' | `human` · `agent` (an AI account, 02 §9.2) |
| owner_user_id | TEXT NULL FK → users ON DELETE CASCADE | set exactly when `kind = 'agent'`: the human who owns it (≤ 3 per owner) |
| email | TEXT UNIQUE NULL | normalised; NOT NULL exactly when `kind = 'human'` (agents have no email and can't sign in) |
| display_name | TEXT NULL | NULL until onboarding completed (06 §5). Wherever a name is shown (UI, push, email) and it is NULL, the fallback label "New player" is used |
| settings | TEXT NOT NULL DEFAULT '{}' | JSON: `{ emailNudges: boolean, whoCanAddMe: "pastOpponents" \| "nobody" (default "pastOpponents", 06 §6.2), lastGameType?: string, lastOptions?: { [gameType]: unknown }, ... }` |
| age_attested_at | INTEGER NULL | when the user confirmed they meet `MIN_AGE` (06 §5); NULL until onboarding completed |
| age_attested_min_age | INTEGER NULL | the `MIN_AGE` value in force when they confirmed. If the operator raises `MIN_AGE` above it, the user is **re-prompted** (06 §5): `onboarded_at` is never cleared, the sweep never deletes them, but they get `403 ONBOARDING_REQUIRED` on the gated endpoints until they confirm again |
| onboarded_at | INTEGER NULL | set when display name and age confirmation are both done (06 §5). Until then the account is treated as unknown for invitations and is deleted by the sweep after 7 days |
| deletion_requested_at | INTEGER NULL | set when account deletion starts; the sweep resumes unfinished deletions (§Account deletion) |
| suspended_at | INTEGER NULL | set by an admin (05 §Admin API). A suspended user can't sign in or use tokens; their sessions and tokens are revoked at suspension. Their games are not touched: seats to act simply time out (02 §4). An agent is suspended with its owner |
| created_at, updated_at | INTEGER | |

### `otp_challenges`
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| email | TEXT NOT NULL | normalised; indexed |
| purpose | TEXT NOT NULL | `signin` · `delete_account` · `step_up` (token creation, admin step-up; 06 §7) — a code only verifies for its purpose |
| code_hash | TEXT NOT NULL | HMAC-SHA256(K_otp, challengeId ‖ code), see 06 §3 |
| attempts | INTEGER NOT NULL DEFAULT 0 | |
| created_at, expires_at | INTEGER | expiry = created + 10 min |
| consumed_at | INTEGER NULL | |
| emailed | INTEGER NOT NULL DEFAULT 1 | 0 for a challenge inserted only for timing parity on the silent new-account path (06 §3.2); such a challenge always fails verify |

At most 3 *live* challenges per (email, purpose); issuing a 4th burns the oldest (06 §3).

### `sessions`
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| user_id | TEXT FK → users ON DELETE CASCADE | indexed |
| token_hash | TEXT UNIQUE NOT NULL | SHA-256 of the 256-bit random token; raw token only in the cookie |
| created_at, last_seen_at, expires_at | INTEGER | sliding expiry, see 06 §4 |
| user_agent | TEXT NULL | truncated to 200 chars, for "your devices" list |

### `games` (game-agnostic — module state lives in `state`)
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| game_type, game_version | TEXT, INTEGER | module id and version (02 §7) |
| options | TEXT NOT NULL | JSON, options as resolved by the module's `resolveOptions`, incl. their versions (e.g. words: `rulesetId`, `rulesetVersion`, `dictionaryId`, `dictionaryVersion`) — public |
| status | TEXT | `lobby` · `active` · `finished` · `declined` · `cancelled` · `expired` (02 §4) |
| created_by | TEXT NULL FK → users ON DELETE SET NULL | |
| seats | INTEGER NOT NULL | chosen seat count; reduced to joined count at start |
| turn_timeout_days | INTEGER NOT NULL | 1–30, framework-validated (02 §4) |
| seat_order | TEXT NOT NULL | `join` · `random` (02 §4) |
| ai_assistance | TEXT NOT NULL | `off` · `allowed` (02 §9.3) — public |
| state 🔒 | TEXT NULL | module `State` JSON; NULL in `lobby` (setup runs at start) |
| setup_rng 🔒 | TEXT NULL | random draws consumed at start: seat-order draw, then `setup` (replay, 02 §5) |
| final_views | TEXT NULL | JSON `{ seats: { view, summary }[], public: { view, summary } }`, written on any terminal status after start (`finished`, or `declined` before a first action, 02 §5). A player only ever receives `seats[theirSeat]` |
| version | INTEGER NOT NULL DEFAULT 0 | optimistic concurrency, 03 §5.2 |
| write_token | TEXT NULL | per-transition guard token, 03 §5.2 |
| action_count | INTEGER NOT NULL DEFAULT 0 | |
| last_action_at | INTEGER NOT NULL | initialised to `created_at`; ordering |
| end_reason | TEXT NULL | module `result().endReason`, or framework reasons `declined` / `cancelled` / `expired` |
| created_at, updated_at, started_at, ended_at | INTEGER | |

### `game_players`
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| game_id | TEXT FK → games ON DELETE CASCADE | |
| seat | INTEGER NULL | NULL in the lobby; assigned `0..n-1` at start by `seat_order` (02 §4) |
| user_id | TEXT NULL FK → users ON DELETE SET NULL | NULL for an email-invite seat or after account deletion |
| invite_email | TEXT NULL | normalised; the address the creator typed, on any seat added by email (email-invite seat or user invitation) while `invited`. Shown only to the creator. Cleared on accept and on any terminal outcome (06 §6.5) |
| state | TEXT | `invited` · `joined` · `declined` · `left` · `removed` (lobby) · `playing` · `out` (seated, active/finished) · `dropped` (unfilled invitation at start); `declined`/`left`/`removed`/`dropped` rows stay after start with `seat` NULL (02 §4) |
| out_reason | TEXT NULL | `eliminated` · `resigned` · `timed_out` · `declined` (out before a first action; never ranked, 02 §4) |
| joined_via | TEXT NULL | `creator` · `added` (auto-joined past opponent) · `invitation` (accepted — including an invited user who joins through the link, 02 §4) · `email_invite` · `join_link` |
| delivery | TEXT NOT NULL DEFAULT 'normal' | for `invited` rows: `normal` · `hidden` (over the target's inbound cap, 06 §6.7: shown only in their collapsed *Hidden invitations*, no notification) · `inert` (blocked pair, or a typed address that resolves to a user already added in the same request: never delivered, never claimable, never accepted, `user_id` NULL for the latter, 06 §6.1). The creator sees all three the same way (Q3) |
| removed_at | INTEGER NULL | when the creator removed this seat; compared with `join_links.created_at` (06 §6.8) |
| joined_at | INTEGER NULL | for `seat_order = join`, and "who joined later" in the start-time block check (02 §4). A row with `joined_at` NULL never exposes a display name or user id in any response (05 §Common types) |
| to_act | INTEGER NOT NULL DEFAULT 0 | 1 if this seat is in `toAct` — denormalised for "your turn" queries; updated in the same transition |
| to_act_since | INTEGER NULL | per-seat timeout clock (02 §2.3) |
| acted_once | INTEGER NOT NULL DEFAULT 0 | for "decline before first action" (02 §4) |
| rank, score | INTEGER NULL | from module `result()`, re-ranked without `declined` seats (02 §4); NULL for everyone when the game ends `declined` |
| last_seen_version | INTEGER NOT NULL DEFAULT 0 | unread badges |
| last_nudged_at | INTEGER NULL | email nudge throttle |
| timeout_reminders_sent | INTEGER NOT NULL DEFAULT 0 | 0–2 (02 §4) |

Unique (game_id, user_id) where user_id not null; unique (game_id, seat) where seat not null.
Indexes: `(user_id, to_act)`, `(user_id, state)`, `invite_email`. At start, rows not `joined` keep
their row with `seat` NULL (unfilled invitations become `dropped`, 02 §4), so blocks can still
target people who shared a lobby (05 §Blocks).

**Membership.** A user is a member of a game, for reads, actions and realtime, only through a row
in state `joined`, `playing` or `out`, or an `invited` row with their `user_id` whose `delivery` is
`normal` or `hidden` (they can see the invitation; `view` is null in the lobby). Rows in
`declined`, `left`, `removed` or `dropped`, and `inert` invitations, give no access (`404`).
`yourSeat` always comes from the member's own row, and only `playing`/`out` rows have a seat.

### `game_actions` (append-only log of module transitions, 02 §5)
| Column | Type | Notes |
|---|---|---|
| game_id | TEXT FK ON DELETE CASCADE | PK(game_id, seq) |
| seq | INTEGER | 1-based; equals `games.action_count` after insert |
| seat | INTEGER NOT NULL | the acting (or resigning/declining/timed-out) seat |
| kind | TEXT | `action` · `resign` · `timeout` · `decline` (a decline or timeout before a first action, after start, when the game continues; replayed as `onResign(…, "decline")`). Lobby events, invite claims and the framework-only `declined` ending are not logged (02 §5) |
| action 🔒 | TEXT NULL | the module action as submitted (secret: e.g. which tiles were swapped); NULL for other kinds |
| record | TEXT NOT NULL | module `PublicRecord` JSON — public |
| describe | TEXT NOT NULL | JSON `Text` from module `describe(record)` (02 §5) — public |
| rng 🔒 | TEXT NULL | random draws consumed (replay) |
| via | TEXT NOT NULL DEFAULT 'app' | `app` (cookie session) · `token` (an API token: an AI move, 02 §9.1) · `system` (timeouts). Public; history shows token moves as AI or AI-assisted |
| created_at | INTEGER | |

### `game_resources`
| Column | Type | Notes |
|---|---|---|
| game_id | TEXT FK → games ON DELETE CASCADE | PK(game_id, kind, resource_id) |
| kind | TEXT | e.g. `dictionary` |
| resource_id | TEXT | indexed (purge checks, words §9.5) |
| version | INTEGER NULL | `ResourceRequest.version` as resolved at creation (02 §2) |

Written at creation from the module's `resources(options)`. Its `kind` values are the framework's
resource kinds (02 §2.1 rule 7).

### `past_opponents`
| Column | Type | Notes |
|---|---|---|
| user_id | TEXT FK → users ON DELETE CASCADE | PK(user_id, other_id) |
| other_id | TEXT FK → users ON DELETE CASCADE | |
| last_finished_at | INTEGER | indexed per user, for the recent-players list |

Written (both directions) in the transition that finishes a game (status `finished` only), for
every pair of seated users who **both** have `acted_once = 1`, except players who joined through a
link: they're never paired automatically. The creator may confirm one afterwards ("Add <name> to
your players?", `POST /api/v1/games/:id/add-player`, 05), which writes only creator ↔ that player, and
only if both acted (06 §6.9). **Never written for a pair with a block in either direction** (checked
in the same transition), and deleted in both directions when either user blocks the other. Read by
`whoCanAddMe` checks and `/api/v1/players/recent`.

### `join_links`
| Column | Type | Notes |
|---|---|---|
| game_id | TEXT PK FK → games ON DELETE CASCADE | one live link per game |
| token_hash | TEXT UNIQUE NOT NULL | SHA-256 of the 128-bit token; the raw token is shown only in the create/rotate response |
| created_at, expires_at | INTEGER | expiry ≤ 7 days and ≤ lobby expiry; deleted at game start/revoke/rotate; swept when expired |

A user whose row has `removed_at ≥ join_links.created_at` can't use the current link; rotating it
issues a new token (and a newer `created_at`), which re-admits them (06 §6.8).

### `invites`
Tracks invitation emails (for rate limiting, expiry and abuse handling). Stores no raw address.

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| game_id | TEXT FK → games ON DELETE CASCADE | |
| inviter_id | TEXT FK → users ON DELETE CASCADE | |
| email_hash | TEXT | `emailId` (HMAC, 09 §1.1) of the normalised address |
| sent_at | INTEGER NULL | |
| expires_at | INTEGER | = lobby expiry: 14 days from the game's `created_at` (02 §4) |

### `email_suppressions`
Addresses that asked never to receive invite/nudge emails, or that hard-bounced.

| Column | Type | Notes |
|---|---|---|
| email_hash | TEXT PK | HMAC-SHA256(server secret, normalised email) — we don't keep the raw address of non-users |
| reason | TEXT | `unsubscribed` · `bounced` · `complained` |
| created_at | INTEGER | |

OTP emails are transactional and still sent to suppressed addresses (the person is actively asking
to sign in).

### `blocks`
| blocker_id | blocked_id | created_at |  PK(blocker_id, blocked_id), both FK → users ON DELETE CASCADE.

### `push_subscriptions`
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| user_id | TEXT FK ON DELETE CASCADE | |
| session_id | TEXT FK → sessions ON DELETE CASCADE | subscription dies with the session (06 §4) |
| endpoint | TEXT UNIQUE | validated per 08 T12; on conflict the row is reassigned to the current user/session (upsert) |
| p256dh, auth | TEXT | base64url; validated as a 65-byte uncompressed P-256 point and 16 bytes respectively |
| created_at, last_success_at | INTEGER | delete on 404/410 from push service. Max 10 per user (oldest evicted) |

### `dictionaries` (uploaded and operator dictionaries — built-ins live in the code registry)
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | `u_<uuid>` for uploads; operator ids match `^[a-z][a-z0-9-]{1,31}$`, never start with `u_`, never equal a registry id (words §9.5) |
| kind | TEXT | `upload` · `operator` |
| owner_id | TEXT NULL FK → users ON DELETE SET NULL | uploader; NULL for operator dictionaries |
| name | TEXT NOT NULL | validated like display names |
| language | TEXT NOT NULL | e.g. `en` |
| alphabet | TEXT NOT NULL | sorted letters used |
| word_count, size_bytes | INTEGER | |
| sha256 | TEXT NOT NULL | of the normalised list |
| blob_key | TEXT NOT NULL | server-generated UUID `BlobStore` key, never derived from input; never returned by any API |
| rights_attested_at | INTEGER NULL | uploads only |
| created_at | INTEGER | |
| deleted_at | INTEGER NULL | hidden from pickers; blob purged by sweep once no `lobby`/`active` game references it in `game_resources` |
| purged_at | INTEGER NULL | set when the blob is deleted; until then the upload counts toward the owner's quota (words §9.5) |

Index on `owner_id`.

### `rate_limits`
| key | TEXT | e.g. `otp:email:<hash>`, `otp:ip:<hash>`, `invite:user:<id>` |
| window_start | INTEGER | |
| count | INTEGER | PK(key, window_start); swept hourly |

### `api_tokens` (06 §8)
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | public token id, shown in the token list |
| user_id | TEXT FK → users ON DELETE CASCADE | the account the token acts as: the creator, or one of their agents |
| created_by | TEXT FK → users ON DELETE CASCADE | always a human (the agent's owner for agent tokens) |
| name | TEXT NOT NULL | user-chosen label, ≤ 40 chars |
| token_hash | TEXT UNIQUE NOT NULL | HMAC-SHA256(K_token, secret part); the raw token is shown once |
| scopes | TEXT NOT NULL | JSON array, subset of `read` · `play` · `admin` |
| created_at, expires_at | INTEGER | expiry ≤ created + 365 days |
| last_used_at | INTEGER NULL | updated at most once a minute |
| revoked_at | INTEGER NULL | |

At most 10 live tokens per account. Index on `user_id`.

### `admin_audit` (append-only, retained 2 years)
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| actor_user_id | TEXT NULL FK → users ON DELETE SET NULL | the admin |
| via | TEXT NOT NULL | `session` · `token` (token id recorded in `detail`) |
| action | TEXT NOT NULL | e.g. `user.suspend`, `game.cancel`, `dictionary.add` (05 §Admin API) |
| target_type, target_id | TEXT NULL | e.g. `user` + user id, `game` + game id; never an email |
| detail | TEXT NULL | JSON, no secrets, no emails, no hidden game state |
| request_id | TEXT NOT NULL | correlates with logs |
| created_at | INTEGER | |

No route updates or deletes rows; the repository exposes insert and read only. Account deletion
sets `actor_user_id` / `target_id` of a deleted user to NULL, keeping the pseudonymous history.

### `auth_events` (security audit, retained 90 days)
| id | user_id NULL | type (`otp_requested`, `otp_failed`, `signed_in`, `signed_out_all`, `display_name_changed`, `under_age_exit`, `account_deleted`, `token_created`, `token_revoked`, `token_rejected`, `agent_created`, `agent_deleted`) | ip_hash | created_at |

## Invariants (enforced by tests)

Framework-level (module-specific invariants live in each game doc):

1. **Replay**: `setup(options, seats, setup_rng)` followed by dispatching `game_actions` in `seq`
   order by `kind` (02 §5) with their recorded `rng` reproduces `games.state` exactly.
2. `games.version` increases by exactly 1 per accepted transition (03 §5.2), and never otherwise.
3. `game_players.to_act = 1` exactly for the seats in the module's `toAct(state)`; none when the
   game isn't `active`. While the game is `active`, `state = out` exactly for the seats
   `seatStatus(state)` reports `out` (the framework-only `declined` ending sets the decliner `out`
   without the module, 02 §4).
4. **Secrecy**: no API response, WebSocket message, push payload or log line contains `state`,
   `setup_rng`, `game_actions.action` or `game_actions.rng`, or another seat's entry of
   `final_views`. Game data reaches clients only through module `view()` (or the viewer's own
   `final_views` entry), public `record`s and `describe` text. Enforced by response-schema type
   tests, a route-wide runtime test, and the module perturbation test (02 §6).
5. After start, a `game_players` row has a non-NULL `seat` exactly when its state is `playing` or
   `out`; every other row has `seat` NULL and is `declined`, `left`, `removed` or `dropped`.
6. **Blocks and past opponents**: no `past_opponents` row ever exists for a pair with a block in
   either direction (06 §6.10).
7. **Agents**: a `kind = 'agent'` user has `owner_user_id` set and `email` NULL, has no sessions,
   OTP challenges, push subscriptions, blocks or `past_opponents` rows, holds no `game_players` row
   other than `joined`/`playing`/`out` in a game its owner created, and never appears as an
   invitee.

## Account deletion

D1 has no interactive transactions, so deletion is a resumable sequence of idempotent steps, each
game handled by its own `write_token` transition (with the usual retries, 02 §4). Sessions are
deleted first, so the account is unusable from the moment deletion starts.

1. Delete sessions and API tokens (cascades push subscriptions; live sockets closed, 06 §4).
   The user's AI accounts are deleted first by this same sequence (02 §9.2).
2. For each of the user's games:
   - `active` where they're `playing`: a real resign transition (module `onResign`; others notified),
     or the decline rule if they haven't acted yet (02 §4);
   - `lobby` they created: cancel (deleting its `invites`/`join_links` rows and clearing every
     `invite_email` — third parties' addresses; realtime invalidation only, no push or email, 02 §4);
   - other `lobby` games: a real `leave` (or decline, if `invited`) transition, so no orphaned
     `joined` seat can auto-start a game.
3. Delete OTP challenges for the email, blocks and `past_opponents` rows in both directions. Mark the
   user's uploaded dictionaries deleted (`deleted_at`); the sweep purges their blobs once
   unreferenced.
4. `auth_events`: set `user_id` NULL (keeps pseudonymous security history for its 90-day retention);
   `admin_audit`: set the user's `actor_user_id`/`target_id` NULL.
5. Delete the `users` row last: `game_players.user_id` and `games.created_by` become NULL via FK
   actions; finished games show "Deleted player". Opponents' history stays intact.

Accounts that never finished onboarding (`onboarded_at` NULL) hold no game rows (invitations are
claimed only at onboarding, 06 §6.4), so their deletion — immediately when the user says they're
under `MIN_AGE`, or by the sweep 7 days after creation (06 §5) — is steps 1, 3, 4 and 5, with no
step-up code. The under-age exit also adds the address to `email_suppressions` (reason
`unsubscribed`) and makes every `invited` email seat for it `inert`, so no more invite emails
arrive. A user **re-prompted** after a `MIN_AGE` rise who says they're under it is only signed out
of that session; their account is deleted only through the normal step-up path (06 §5, §7).

If a step fails, the deletion is retried from the start by the next sweep (a `deletion_requested_at`
marker on the user row); every step is safe to repeat.

Backups containing the user age out per the retention documented in 09 §4 (stated on the privacy
page).
