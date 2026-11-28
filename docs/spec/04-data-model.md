# 04 — Data model

SQLite dialect (D1 and `node:sqlite`). Defined once in Drizzle (`packages/server/src/db/schema.ts`)
with generated SQL migrations in `packages/server/migrations/` (`pnpm --filter @your-move/server
db:generate <name>`, reviewed and committed), applied by `wrangler d1 migrations apply` on
Cloudflare and by the Node runtime on startup; §Migrations below has the rules. Every table below
is created by the first migration, before the milestones that use it.

Conventions:

- IDs: `TEXT` UUIDv4 from `crypto.randomUUID()`.
- Timestamps: `INTEGER` milliseconds since epoch (UTC).
- JSON columns: `TEXT` containing JSON, parsed and validated by Zod on read.
- Emails are stored **normalised**: trimmed, Unicode NFC, lower-cased. No provider-specific
  canonicalisation (dots / `+tags` are kept as typed). Must match a pragmatic address regex and be
  ≤ 254 chars. The stored domain is **ASCII**, so the stored address is the one mail is delivered
  to (09 §2): a domain with any ASCII character other than letters, digits, `.` and `-`, or one
  that NFKC would rewrite, is refused; an internationalised domain is stored as punycode with the
  same number of labels. An address is accepted only if the mail builder can send it as it stands:
  an ASCII dot-atom local part of at most 64 characters (no leading, trailing or consecutive
  dots, no non-ASCII), labels of at most 63 characters, a domain of at most 253, and a top-level
  label that isn't all digits; one shared rule, so the two can't drift (a non-ASCII local part is
  refused, with the same `400` as any invalid address). `EMAIL_FROM` must satisfy the same rule
  unless the provider is `console`. This happens before any limit or lookup, identically for every address.
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
| email_id | TEXT UNIQUE NULL | the address's `emailId` (09 §1.1), set exactly while `settings.emailNudges` is true — written when the user turns email nudges on, cleared when they are turned off (in Settings or by an unsubscribe) — so a `nudges` unsubscribe token, which carries only the `emailId` (05 §Email links), can find the account |
| display_name | TEXT NULL | NULL until onboarding completed (06 §5). The display-name rules (06 §5.1) are checked when a name is set; a later change to them (e.g. alpha A17's digit count) never rewrites or refuses a stored name. Wherever a name is shown (UI, push, email) and it is NULL, the fallback label "New player" is used |
| settings | TEXT NOT NULL DEFAULT '{}' | JSON: `{ emailNudges: boolean (default false, 03 §7), whoCanAddMe: "pastOpponents" \| "nobody" (default "pastOpponents", 06 §6.2), theme: "system" \| "light" \| "dark" (default "system", 07 §5), lastGameType?: string, lastOptions?: { [gameType]: unknown }, ... }` |
| age_attested_at | INTEGER NULL | when the user confirmed they meet `MIN_AGE` (06 §5); NULL until the user confirms (which may come before or after the display name, so before onboarding completes) |
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
| purpose | TEXT NOT NULL | `signin` · `delete_account` · `token_create` · `token_admin` (06 §7) — a code only verifies for its purpose, and each purpose has its own email template |
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
| setup_rng 🔒 | TEXT NULL | random draws consumed at start: seat-order draw, then `setup` (replay, 02 §5); JSON `[maxExclusive, value]` pairs, so a replay detects a changed draw range |
| final_views | TEXT NULL | JSON `{ seats: { view, summary }[], public: { view, summary } }`, written on any terminal status after start (`finished`; `declined` before a first action; `cancelled` by an operator), except for an orphaned game whose engine is gone (02 §5, §7.3). A player only ever receives `seats[theirSeat]` |
| version | INTEGER NOT NULL DEFAULT 0 | optimistic concurrency, 03 §5.2 |
| write_token | TEXT NULL | per-transition guard token, 03 §5.2 |
| action_count | INTEGER NOT NULL DEFAULT 0 | |
| last_action_at | INTEGER NOT NULL | initialised to `created_at`; ordering |
| end_reason | TEXT NULL | module `result().endReason`, or framework reasons `declined` / `cancelled` / `operator_cancelled` / `expired` |
| created_at, updated_at, started_at, ended_at | INTEGER | |
| rematch_game_id | TEXT NULL UNIQUE FK → games | a `finished` game's current rematch (05 `POST /api/v1/games/:id/rematch`, alpha A15): written in the same batch that inserts the rematch, by a conditional update that holds only while the game is `finished` and this column is NULL or names a game that **ended unplayed** (any `declined` ending (02 §2.1 rule 9: a seat refused before its first action, whatever others did), or `cancelled` or `expired` with no action logged (`action_count = 0`) — except an operator's cancel (`end_reason = operator_cancelled`), which is never unplayed), and every insert of that batch holds only while the update can (so a batch that loses the race writes nothing). Replaced only in that case: never while the linked game is in its lobby, active or finished, once it was cancelled or expired after an action, or when an operator cancelled it. Not a transition (the game's `version` is unchanged). Shown only to the game's players, as the envelope's `rematch` (05) |

### `game_players`
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| game_id | TEXT FK → games ON DELETE CASCADE | |
| seat | INTEGER NULL | NULL in the lobby; assigned `0..n-1` at start by `seat_order` (02 §4) |
| user_id | TEXT NULL FK → users ON DELETE SET NULL | NULL for an email-invite seat or after account deletion |
| invite_email | TEXT NULL | normalised; the address the creator typed, on any seat added by email (email-invite seat or user invitation) while `invited`. Shown only to the creator. Cleared on accept and on any terminal outcome (06 §6.5) |
| state | TEXT | `invited` · `joined` · `declined` · `left` · `removed` (lobby) · `playing` · `out` (seated, active/finished) · `dropped` (unfilled invitation at start); `declined`/`left`/`removed`/`dropped` rows stay after start with `seat` NULL (02 §4) |
| out_reason | TEXT NULL | `eliminated` · `resigned` · `timed_out` · `declined` (out before a first action; never ranked, 02 §4) · `cancelled` (operator cancel of an active game, 02 §4) |
| joined_via | TEXT NULL | `creator` · `added` (auto-joined past opponent) · `invitation` (accepted — including an invited user who joins through the link, 02 §4) · `email_invite` · `join_link` |
| delivery | TEXT NOT NULL DEFAULT 'normal' | for `invited` rows: `normal` · `hidden` (over the target's inbound cap, 06 §6.7: shown only in their collapsed *Hidden invitations*, no notification) · `inert` (blocked pair, a typed address that resolves to a user already added in the same request, or an email-invite seat whose address took the under-age exit: never delivered, never claimable, never accepted, `user_id` NULL for the latter two, 06 §6.1, §5). The creator sees all three the same way (Q3) |
| removed_at | INTEGER NULL | when the creator removed this seat. A removed row never comes back through any join link, rotated or new (06 §6.8) |
| joined_at | INTEGER NULL | for `seat_order = join`, and "who joined later" in the start-time block check (02 §4). A row with `joined_at` NULL never exposes a display name or user id in any response (05 §Common types) |
| to_act | INTEGER NOT NULL DEFAULT 0 | 1 if this seat is in `toAct` — denormalised for "your turn" queries; updated in the same transition |
| to_act_since | INTEGER NULL | per-seat timeout clock (02 §2.3) |
| acted_once | INTEGER NOT NULL DEFAULT 0 | for "decline before first action" (02 §4) |
| rank, score | INTEGER NULL | from module `result()`, re-ranked without `declined` seats (02 §4); NULL for everyone when the game ends `declined` |
| last_seen_version | INTEGER NOT NULL DEFAULT 0 | unread badges: the game is unread while `games.version` is above it. A member's own transition sets it to the version it creates; an invitation, and a past opponent added at once (`joined_via = added`), starts at `-1`, so it is unread until seen |
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
| rng 🔒 | TEXT NULL | random draws consumed (replay), as `[maxExclusive, value]` pairs like `games.setup_rng` |
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
| created_at, expires_at | INTEGER | expiry ≤ 7 days and ≤ lobby expiry; deleted at game start/revoke/rotate and when the lobby ends any other way (cancelled, declined, expired); swept when expired |

A user whose row is `removed` (or `declined`, `left`) can't use any link of the game, the current
one, a rotated one or a new one: a removal sticks across links (06 §6.8, alpha A18 review S-3).

### `invites`
Tracks invitation emails (for rate limiting, expiry and abuse handling). Stores no raw address.

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| game_id | TEXT FK → games ON DELETE CASCADE | |
| inviter_id | TEXT FK → users ON DELETE CASCADE | |
| email_hash | TEXT | `emailId` (HMAC, 09 §1.1) of the normalised address |
| sent_at | INTEGER NULL | when the sender accepted the invite email, set by the background task that sends it, never before the response (06 §6.3); or, for a typed address of a user with email nudges on, the invitation email (06 §6.2, alpha A20); NULL when none was sent (an invitation to a user without nudges, a suppressed address or `hidden` seat, a cap, a failed send) |
| expires_at | INTEGER | = lobby expiry: 14 days from the game's `created_at` (02 §4) |

Since alpha A20 (review S-1) an invite's `id` is its seat's `game_players.id`, so the inbound cap
(06 §6.7) can tell a live invitation from one whose seat was removed or whose lobby ended unplayed;
an older row's id matches no seat and counts until its lobby ends.

### `email_suppressions`
Addresses that must not get our non-OTP emails. `unsubscribed` (the invites unsubscribe, 05
§Email links, and the under-age exit) stops invite emails and the invitation email to a user
with nudges on (06 §6.2, alpha A20) only: the turn nudges have their own opt-out, the setting
and `users.email_id` (03 §7). Turning email nudges on deletes the account's own address's
`unsubscribed` row, the holder's explicit opt-in (alpha A20 review P-3); nothing else deletes a
row. `bounced` and `complained` stop every non-OTP email, nudges included. One row per address: a `bounced` or `complained` row replaces an
`unsubscribed` one (it stops more mail), never the reverse, and otherwise the first row stays;
`created_at` is when the row's current reason was recorded.

| Column | Type | Notes |
|---|---|---|
| email_hash | TEXT PK | the address's `emailId`: HMAC-SHA256 under the `email-id/v1` subkey (09 §1.1) of the normalised address — we don't keep the raw address of non-users |
| reason | TEXT | `unsubscribed` · `bounced` · `complained` (precedence below) |
| created_at | INTEGER | when the current reason was recorded |

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
| endpoint | TEXT UNIQUE | validated per 08 T12 and stored as the parsed URL (what every push is posted to); on conflict (upsert, keeping its id): the same user and session update its keys; another user or session takes it over only when the keys sent equal the stored ones (the same browser subscription) or the stored row's session is no longer live (06 §4; such a row gets no pushes, owner decision in the alpha A8 review round 2), and otherwise nothing changes and the answer is the same `204` (no ownership oracle, alpha A8 review); `created_at` and `last_success_at` are kept for the same user and start afresh when the endpoint changes hands |
| p256dh, auth | TEXT | base64url; validated as a 65-byte uncompressed P-256 point and 16 bytes respectively |
| created_at, last_success_at | INTEGER | delete on 404/410 from push service. Max 10 per user: rows whose session isn't live are evicted first, then the least recently useful (by `COALESCE(last_success_at, created_at)`), in the same batch as the upsert; the subscription just saved is never the one evicted. Only rows whose session is live receive pushes (03 §7) |

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
| key | TEXT | e.g. `otp:email:<hash>`, `otp:ip:<hash>`, `invite:user:<id>`, and the fixed keys `all` (instance-wide sends) and `silent` (requests, or typed addresses, that sent or counted nothing; written, never read, 06 §3.2, §6.6, §6.7) |
| window_start | INTEGER | |
| count | INTEGER | PK(key, window_start); swept hourly |

### `api_tokens` (06 §8)
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | public token id, shown in the token list |
| user_id | TEXT FK → users ON DELETE CASCADE | the account the token acts as: the creator, or one of their agents |
| created_by | TEXT FK → users ON DELETE CASCADE | always a human (the agent's owner for agent tokens) |
| name | TEXT NOT NULL | user-chosen label; display-name rules (06 §5.1); HTML-escaped in emails, never in a subject |
| token_hash | TEXT UNIQUE NOT NULL | HMAC-SHA256(K_token, secret part); the raw token is shown once |
| scopes | TEXT NOT NULL | JSON array: `read` plus any of `play` · `games:create` · `join`; or exactly `["admin"]` (exclusive, admins only, never for an agent). Agent tokens: `read`, `play` only (06 §8) |
| created_at, expires_at | INTEGER | expiry ≤ created + 365 days; ≤ created + 30 days for `admin` |
| last_used_at | INTEGER NULL | updated at most once a minute |
| revoked_at | INTEGER NULL | |

At most 10 live tokens per account. Index on `user_id`.

### `admin_audit` (append-only, retained 2 years)
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| actor_key | TEXT NOT NULL | stable pseudonymous key of the admin: their `emailId` (HMAC of the address, 09 §1.1); **not** a foreign key, so it survives the admin's own account deletion |
| actor_user_id | TEXT NULL FK → users ON DELETE SET NULL | the admin's user id while the account exists |
| token_id | TEXT NOT NULL | the admin token used (admin access is by token only, 05 §Admin API) |
| action | TEXT NOT NULL | e.g. `user.suspend`, `game.cancel`, `dictionary.add` (05 §Admin API) |
| target_type, target_id | TEXT NULL | e.g. `user` + user id, `game` + game id; never an email |
| detail | TEXT NULL | JSON, no secrets, no emails, no hidden game state |
| request_id | TEXT NOT NULL | correlates with logs |
| created_at | INTEGER | |

Only requests from admin principals are written here (refused requests from non-admins are logged
and rate-limited instead, 05 §Admin API). No route updates or deletes rows; the repository exposes
insert and read only. Account deletion sets `actor_user_id` / `target_id` of a deleted user to
NULL but keeps `actor_key`, so an admin deleting their own account can't erase their audit trail;
an admin's self-deletion is itself audited (`user.delete_self`).

### `auth_events` (security audit, retained 90 days)
| id | user_id NULL (FK → users ON DELETE SET NULL) | type (`otp_requested`, `otp_failed`, `signed_in`, `signed_out_all`, `display_name_changed`, `under_age_exit`, `account_deleted`, `token_created`, `token_revoked`, `token_rejected`, `agent_created`, `agent_deleted`) | ip_hash | created_at |

## Schema details beyond the tables above (M2a)

The schema (`schema.ts`) also makes these choices, which the tables above leave open:

- **NOT NULL** wherever every row has a value: `sessions.user_id`, `games.game_type`,
  `games.game_version`, `games.status`, `game_players.game_id`, `game_players.state`,
  `game_actions` (`game_id`, `seq`, `seat`, `kind`, `created_at`), `game_resources` (`kind`,
  `resource_id`), `invites` (`game_id`, `inviter_id`, `email_hash`, `expires_at`),
  `email_suppressions` (`reason`, `created_at`), `blocks.created_at`, `push_subscriptions`
  (`endpoint`, `p256dh`, `auth`, `created_at`), `dictionaries` (`kind`, `word_count`,
  `size_bytes`, `created_at`), `rate_limits` (`window_start`, `count`), `api_tokens.created_at`
  and `expires_at`, `admin_audit.created_at`, `auth_events` (`type`, `created_at`), and every
  `created_at`/`updated_at`/`expires_at`/`last_seen_at` that has no NULL meaning.
- **Uniqueness of `game_players`**: plain `UNIQUE(game_id, user_id)` and `UNIQUE(game_id, seat)`.
  SQLite treats NULLs as distinct in a unique index, so this is exactly "unique where not null",
  and the indexes also serve every lookup by `game_id`.
- **Extra indexes** for sweeps, cascades and lookups: `users(owner_user_id)`,
  `otp_challenges(email, purpose)`, `games(status, game_type)`, `games(created_by)`,
  `past_opponents(user_id, last_finished_at)` and `(other_id)`, `invites` (`game_id`, `inviter_id`,
  `email_hash`), `blocks(blocked_id)`, `push_subscriptions` (`user_id`, `session_id`),
  `rate_limits(window_start)`, `api_tokens(created_by)`, `admin_audit` (`created_at`,
  `actor_user_id`), `auth_events` (`user_id`, `created_at`).
- **`auth_events.user_id`** is a foreign key with `ON DELETE SET NULL` (account deletion step 4).
- **`games.rematch_game_id`** is a foreign key with no `ON DELETE` action: games are never deleted,
  and drizzle-kit's `ALTER TABLE … ADD` drops an action, which `pnpm db:check` would then report
  against a fresh generation (alpha A15).

## Migrations

- Generated by drizzle-kit from `schema.ts` (`pnpm --filter @your-move/server db:generate <name>`),
  reviewed and committed. `pnpm db:check` (CI's validate job) fails if:
  - the journal's entries aren't numbered in order with strictly increasing `when`, or the `.sql`
    files aren't exactly the journal's tags;
  - a migration breaks one of the text rules below (one reading, refused statements, unreviewed
    table rebuilds or dropped columns);
  - the schema the committed migrations build differs from the schema built by a fresh drizzle-kit
    generation from `schema.ts` into an empty folder. Each is applied to its own in-memory SQLite
    database and compared by what SQLite reports: every table's `table_list` entry (its `STRICT`
    and `WITHOUT ROWID` flags), `table_xinfo` (column positions aside, since
    `ALTER TABLE ADD COLUMN` always appends; `hidden` marks a generated column) and
    `foreign_key_list`, every index's `index_list` entry, `index_xinfo` and SQL in `sqlite_schema`
    (which carries a partial index's `WHERE`), and the SQL of any view or trigger. SQLite's own
    objects are compared too rather than filtered out: SQLite refuses a user object whose name
    starts with `sqlite_` in any case, so a filter could only hide one (`sqlite_sequence` also
    shows that some table uses `AUTOINCREMENT`). Both databases are opened with SQLite's
    defensive flag, and the check fails if either leaves anything in its connection's `temp`
    schema. The clauses no pragma reports are read from each table's SQL in `sqlite_schema` with
    comments, quoting, case and spacing normalised: each column's `COLLATE`, `CHECK` and generated expression
    (`[GENERATED ALWAYS] AS (…)`), the table's `CHECK` constraints, and each foreign key's
    `[NOT] DEFERRABLE [INITIALLY …]`, keyed by its columns and parent table so that an inline
    `REFERENCES` and a table-level `FOREIGN KEY` compare alike. A hand edit to a committed `.sql`
    file (an FK action, a default, an index's columns or predicate, any of those clauses) therefore
    fails. What none of these covers — constraint names, `ON CONFLICT` clauses, which table uses
    `AUTOINCREMENT`, a primary key's `ASC`/`DESC`, a foreign key's `MATCH` clause (which SQLite
    parses and ignores) — is the reviewer's to catch;
  - drizzle-kit, generating over a copy of the committed folder, writes or changes any file there
    (a `schema.ts` change without its migration and snapshot), or doesn't report "No schema
    changes".
- **Cloudflare** applies them with `wrangler d1 migrations apply` (tracked in `d1_migrations`).
- **Node** applies them at startup (02 §7.3), tracked by hash in Drizzle's `__drizzle_migrations`
  table: every known migration whose hash isn't recorded runs, in journal order, all in one
  transaction; a recorded hash the build doesn't know (a newer build's, or a migration edited after
  it ran) refuses the start. They run on a connection of their own, opened after the
  single-instance lock is taken and closed before the server's connection opens, so nothing a
  migration could leave on its connection reaches the server (an in-memory database, which exists
  only on its one connection, is migrated on that; it is for local development and tests only).
  Foreign keys are off while they run (`PRAGMA foreign_keys` is a
  no-op inside a transaction, so this is set before it begins). When any migration is pending,
  `PRAGMA foreign_key_check` must come back empty both before the first one runs (a violation
  already in the database refuses the start with its own message) and before the commit, or
  nothing is applied; with nothing pending it isn't run.
- **One reading.** A migration is applied two ways: whole on Cloudflare, as SQLite and
  `wrangler d1 migrations apply` read it (where `--> statement-breakpoint` is a comment), and on
  Node cut at every `--> statement-breakpoint` first, the way Drizzle's migrator cuts it, even
  one inside a literal or a comment. Both must run the same statements, so `pnpm db:check`
  refuses a migration that:
  - doesn't contain only printable ASCII, tab and line endings (LF or CRLF; a CR alone is
    refused): write the text in ASCII, and build a non-ASCII literal with `char(…)`;
  - has anything after a `--> statement-breakpoint` on its line;
  - leaves a block comment, string literal or quoted identifier unterminated (in the whole file
    or in any piece between breakpoints);
  - reads as a different list of statements whole and cut at its breakpoints.
- **How the statement rules read a migration.** The rules below look at statements with comments
  removed and whitespace collapsed, so neither hides a pattern, and a leading
  `EXPLAIN [QUERY PLAN]` is ignored (some pragmas act while their statement is prepared). They are
  checked in both readings above, and a review line counts only if it is a real `--` comment in
  both. A review line's `\r\n` line ending is not part of it.
- **No transaction control.** A migration never contains `BEGIN`, `COMMIT`, `END`, `ROLLBACK`,
  `SAVEPOINT` or `RELEASE` (a trigger's `BEGIN … END` body is not transaction control): it would
  break the one-transaction guarantee above. `pnpm db:check` refuses such a migration, with or
  without a review line, and Node refuses to apply one (SQLite's authorizer denies transaction and
  savepoint statements while a migration runs).
- **No pragmas but `foreign_keys`, no `ATTACH`, `DETACH` or `VACUUM`.** `foreign_keys` is the
  only pragma drizzle-kit writes (its table rebuild, below); nothing else a pragma does belongs in
  a migration, and attaching a database or vacuuming reaches outside the schema. `pnpm db:check`
  refuses such a migration, with or without a review line, and Node refuses to apply one (the
  authorizer that denies transaction control also denies any pragma but `foreign_keys` and the
  attach and detach actions; `VACUUM` already fails inside a transaction).
- **No temporary objects.** A migration never creates anything in the connection's `temp`
  schema (`CREATE TEMP …`, `CREATE TEMPORARY …`, or a `temp.` qualifier, as in
  `CREATE TABLE temp.x` or `CREATE TRIGGER temp.t … ON main.x`): a temporary trigger or a table
  shadowing a main one would live on in the connection that migrated, outside the schema
  `pnpm db:check` compares. `pnpm db:check` refuses such a migration, with or without a review
  line (the text rule matches `TEMP`, `TEMPORARY` and a `temp.` qualifier; the schema comparison
  also fails on a non-empty `temp` schema), and Node refuses to apply one (the authorizer denies
  the `CREATE_TEMP_*` actions and any insert into the `temp` schema), besides migrating on a
  connection it then closes.
- **No table rebuilds of parent tables.** D1 always enforces foreign keys, and neither
  `PRAGMA foreign_keys=OFF` nor `defer_foreign_keys` stops the `ON DELETE` actions a `DROP TABLE`
  fires, so drizzle-kit's rebuild (copy to `__new_x`, `DROP TABLE x`, rename) deletes or nulls
  every child row on Cloudflare. A migration containing `DROP TABLE` or `PRAGMA foreign_keys`
  (schema-qualified or quoted, as in `PRAGMA main."foreign_keys"`) is refused by `pnpm db:check`
  unless it carries a line `-- migration-reviewed: <how child rows are preserved on both drivers>`,
  added only after a reviewer has checked that claim (for example: the table has no children, or
  the migration copies and restores them).
- **Dropped columns.** `ALTER TABLE … DROP [COLUMN]` deletes the column's data on both drivers.
  drizzle-kit writes it, beside an `ADD` of the new name, when its rename prompt ("created or
  renamed from another column?") is answered *create* for a column that was in fact renamed, so a
  rename silently becomes data loss. A migration containing `ALTER TABLE … DROP` is refused by
  `pnpm db:check` unless it carries a line `-- migration-reviewed: <why the column's data may go>`,
  added only after a reviewer has checked that claim (for example: the column was never written,
  or its data was copied into another column first).
- **Other statements cascade too.** `REPLACE INTO` (`INSERT OR REPLACE`, an upsert's conflict
  resolution by `REPLACE`) deletes the conflicting row before inserting, and `DELETE` on a parent
  table deletes it outright; either fires the children's `ON DELETE` actions on D1 just as
  `DROP TABLE` does, and on Node too once foreign keys are on. `pnpm db:check` doesn't detect
  these, so the migration's reviewer must.
- **Migrations never rely on `ON DELETE` actions.** Whether they fire differs between the drivers
  (off on Node while migrating, always on on D1), so a migration that removes parent rows deletes
  or nulls their child rows explicitly first.

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
   OTP challenges, push subscriptions, blocks or `past_opponents` rows, never appears as an
   invitee, and holds `game_players` rows only in games its owner created, in state `joined`,
   `playing` or `out` — or `removed` (the creator removed the seat in the lobby) or `left` (the
   agent's deletion left a lobby, §Account deletion). Its onboarding state is its owner's: an
   agent's `age_attested_min_age` stays NULL and `needsOnboarding` / re-prompt are computed from
   the owner (06 §8).

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
     `invite_email` — third parties' addresses; realtime invalidation only, no push or email, 02 §4).
     Until these game steps exist (M4), the deletion batch deletes the `join_links` rows of the
     `lobby` games the user created, and a join link refuses any lobby whose creator row has no
     user, with the same `404` as every other refusal (alpha A18);
   - other `lobby` games: a real `leave` (or decline, if `invited`) transition, so no orphaned
     `joined` seat can auto-start a game.
3. Delete OTP challenges for the email, blocks and `past_opponents` rows in both directions. Mark the
   user's uploaded dictionaries deleted (`deleted_at`); the sweep purges their blobs once
   unreferenced.
4. `auth_events`: write the `account_deleted` event now, while the user row still exists (an
   insert naming a deleted user would fail its foreign key); step 5 then sets `user_id` NULL on
   every event of the user through the FK's `ON DELETE SET NULL`, keeping pseudonymous security
   history for its 90-day retention. `admin_audit`: set the user's `target_id` NULL (it is no
   foreign key; `actor_user_id` is nulled by its FK in step 5, and `actor_key` stays).
5. Delete the `users` row last: `game_players.user_id` and `games.created_by` become NULL via FK
   actions; finished games show "Deleted player". Opponents' history stays intact.

Accounts that never finished onboarding (`onboarded_at` NULL) hold no game rows (invitations are
claimed only at onboarding, 06 §6.4), so their deletion — immediately when the user says they're
under `MIN_AGE`, or by the sweep 7 days after creation (06 §5) — is steps 1, 3, 4 and 5, with no
step-up code. The under-age exit also adds the address to `email_suppressions` (reason
`unsubscribed`; an existing row keeps its reason) and makes every `invited` email seat for it
(no user, `invite_email` the address) `inert`, so no more invite emails arrive; it keeps its
`invite_email`, so the creator sees the seat as before (Q3). The exit's `under_age_exit` event is
written beside `account_deleted`, both before the users row goes. All of it is one atomic batch
whose every statement applies only while the user's `onboarded_at` is still NULL (06 §5), so it
can't race an onboarding that claims seats meanwhile. A user **re-prompted** after a `MIN_AGE` rise who says they're under it is only signed out
of that session; their account is deleted only through the normal step-up path (06 §5, §7).

If a step fails, the deletion is retried from the start by the next sweep (a `deletion_requested_at`
marker on the user row); every step is safe to repeat.

Backups containing the user age out per the retention documented in 09 §4 (stated on the privacy
page).
