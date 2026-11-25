# 06 — Auth & accounts

Sign-up and sign-in are the same flow. There are no passwords and no magic links.

## 1. Why codes, not magic links

On iOS, a home-screen web app has its **own cookie jar, separate from Safari**. A magic link tapped
in Mail opens Safari, signs *Safari* in, and leaves the installed app signed out. A typed (or
autofilled) one-time code signs in whichever context the user is actually in. Codes are therefore a
hard requirement, not a preference.

## 2. Flow

```
[Enter email] --POST /otp/request--> server issues challenge, emails code
[Enter code]  --POST /otp/verify-->  server verifies, creates user if new, creates session
   ├─ onboarding incomplete → [Display name + age confirmation] → PATCH /me (claims invites) → [Game list]
   │                          └─ "I'm under MIN_AGE" → POST /me/under-age (new account: deleted;
   │                                                   re-prompted account: this session signed out)
   └─ otherwise             → [Game list]
```

## 3. One-time codes

- 8 digits, generated with CSPRNG and rejection sampling (uniform 00000000–99999999). Shown in
  emails as two groups of four (`1234 5678`) for readability; input strips the space (§3.3).
- Stored only as `HMAC-SHA256(K_otp, challengeId ‖ code)` where `K_otp` is the HKDF subkey
  `otp/v1` (09 §1); compared in constant time.
- Valid for **10 minutes**, **single use**, max **5 verify attempts** per challenge (then the
  challenge is burned).
- Up to **3 live challenges** per email may exist; a verify is checked against each live
  challenge (newest first, each check consuming one attempt on that challenge). Issuing a 4th
  burns the oldest. This prevents an attacker invalidating the victim's freshly received code by
  requesting another (sign-in DoS).
- Rate limits (all via `rate_limits`, full table in 08 §4; IP bucketing rules in 08 §4.1):
  - per email: 5 code requests / hour, 10 / day; 10 failed verifies / hour across challenges, one
    counter shared by sign-in and step-up codes (§7). A request refused for its IP counts towards
    none of the per-email limits.
  - per IP: 20 code requests / hour, 50 verify attempts / hour.
  - Exceeding a per-email request limit: **no challenge is created, no existing challenge is
    touched, no email is sent**, and the response is still `202` (avoids enumeration and
    email-bombing). Exceeding a per-IP limit returns `429`.
  - Exceeding the per-email failed-verify limit: verifies for that email return `429 RATE_LIMITED`
    until the window passes (temporary lockout; accepted residual DoS risk, logged in
    `docs/security/findings.md`).
  - **Global circuit breaker**: if instance-wide failed verifies exceed a threshold (default 500 /
    hour) or OTP emails exceed the global cap (08 §4), log an alert and, if Turnstile keys are
    configured, require Turnstile on `/otp/request` automatically for 24 h.

### 3.1 Atomicity (MUST)

Attempt counting, consumption and rate limiting must be race-free under parallel requests:

- Before comparing a code: `UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ? AND
  attempts < 5 AND consumed_at IS NULL AND expires_at > ? RETURNING code_hash, emailed`. Zero rows ⇒
  treat as invalid. A challenge with `emailed = 0` (§3.2) still consumes the attempt and runs the
  comparison, then always fails, so it does the same work as a real one and can never be satisfied.
- On match: `UPDATE otp_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`. Only
  the request that changes 1 row proceeds to create a session (invites are claimed later, at
  onboarding, §6.4).
- Rate-limit counters: `INSERT ... ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
  RETURNING count`, then compare. Limits use two adjacent fixed windows weighted (sliding-window
  approximation) to avoid double bursts at window boundaries.
- M2 acceptance includes a test firing 50 parallel verifies at one challenge: at most 5 are
  evaluated and at most 1 succeeds, on both drivers.

### 3.2 Timing parity (MUST)

- `/otp/request` performs the same DB operations on every path (known/unknown email, limited/not)
  and always sends email via `waitUntil` after responding — never awaited in the request. In
  particular, when an unknown email is silently refused because its IP bucket is over the
  new-accounts limit (08 §4), a challenge is still inserted (`emailed = 0`, so it can never be
  satisfied, §3.1), so a following wrong `/otp/verify` does the same attempt-counting work for known and
  unknown addresses.
- A request that sends nothing (per-email limit, new-accounts limit) adds 1 to a separate,
  never-read counter (`silent`) instead of the instance-wide email counters, and schedules a
  background task that does nothing, so every path does the same work before the response. Adding
  0 would write nothing, and not scheduling would skip a step; both made the silent paths
  measurably quicker. Parity covers the work before the response. What happens afterwards on the
  new-accounts-limited path (no email is sent where a known address would get one, and
  the instance-wide cap isn't charged, because it counts sends and is judged on whether a send
  would happen) differs by design (08 §4) and is an accepted risk (findings.md F-14).
- `/otp/verify` computes an HMAC against a dummy key/value when no live challenge exists.
- M2 includes a loose statistical timing test for both endpoints.

### 3.3 Email and input

- Email: subject `"<code> is your <APP_NAME> sign-in code"` with the 8 digits ungrouped (one-time-code
  autofill reads the subject); body repeats the code in two groups, says it expires
  in 10 minutes, "We will never ask you for this code — don't share it with anyone", "If you didn't
  request this, ignore this email", and the approximate request time. A link to the app is fine;
  it must not carry the code.
- Addresses are normalised (04 conventions) before any limit, counter or lookup, identically for
  every address, including the domain rule there: the address stored and counted is the address
  the email is delivered to (09 §2), never a form a URL parser or mail server would rewrite.
- Input field: `inputmode="numeric"`, `autocomplete="one-time-code"`, `pattern="[0-9]*"`,
  paste-friendly (strip spaces/dashes).
- Optional, operator-configurable: Cloudflare Turnstile on `/otp/request` (works on both targets).
  Off by default; enabling it is a documented exception to the "no third-party client resources"
  rule (CSP gains `script-src`/`frame-src https://challenges.cloudflare.com`; privacy page updated).

### 3.4 Guessing odds

Per targeted email: ≤ 10 failed verify requests / hour, each tested against ≤ 3 live codes ⇒
≤ 720 code guesses / day ⇒ ≈ 0.0007 % chance per day with 8 digits (and the attacker must keep the
victim's account supplied with live challenges, which the victim sees as unsolicited code emails).
Across many targets the binding limits are per-IP-prefix (08 §4.1) and the global breaker: at most
≈ 500 failed verifies/hour instance-wide before Turnstile engages ⇒ ≤ 1,500 guesses ⇒ ≈ 0.0015 %
expected takeovers per hour of sustained attack, which is loud (alerts) and then throttled.
8 digits chosen by the owner (Q13); iOS/Android one-time-code autofill makes the extra length
mostly painless.

## 4. Sessions

- On successful verify: generate a 256-bit random token, store `SHA-256(token)` in `sessions`, and
  set cookie:
  `__Host-sid=<token>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000` (400 days, the
  browser maximum).
- Sliding expiry: session valid for **180 days since last use**; `last_seen_at` refreshed at most
  once per hour per session to limit writes. Absolute cap 400 days, then re-verify.
- Session tokens are rotated on sign-in only (no privilege changes exist that would need rotation).
- Logout deletes the session row and clears the cookie; logout-all deletes all rows for the user
  and, when asked (`revokeTokens`, offered and pre-checked in the app), also revokes every API token
  of the user and their AI accounts (§8).
- **Revocation is complete**: deleting a session (logout, logout-all, revoke from the sessions list,
  account deletion) also deletes push subscriptions bound to it (FK cascade, 04) and closes its live
  WebSockets (the server publishes a `session.revoked` control message to the user's realtime
  channel; sockets are tagged with their session id and closed with code `4401`). Sockets also have
  a 24 h maximum lifetime, so a missed revocation can't outlive a day (03 §6).
- On sign-out (and logout-all) the client also unsubscribes its push subscription and clears
  per-game local state — shared devices. Game modules keep per-user, per-game state only in
  `localStorage` keys under the reserved prefix `ym.game.` (`ym.game.<gameType>.<userId>.<gameId>`,
  02 §3, 07 §2), so one `clearClientState()` removes every such key, and nothing else of a
  module's survives the session. It runs on sign-out and sign-out everywhere, in every open tab (a
  `BroadcastChannel` message); a tab that becomes visible checks `/api/v1/me` again, and a launch
  that finds no session clears the game keys too, so a session ended from another device clears
  them as well. The shell's **public word-list cache**
  (`dictionaries-v1`, 07 §4) deliberately survives sign-out: it holds only public, content-addressed
  lists (each stored under the digest of its own contents) and nothing of any user. So does the shell's
  `ym.install-dismissed` flag (07 §4): per device, no user data, and kept across sign-out on purpose.
- **Suspension** (05 §Admin API): suspending a user deletes their sessions and revokes their tokens
  (with the same socket closing as above), cancels the lobbies they created and declines their
  pending invitations (realtime only); their active games continue and time out normally. The
  admin's reason is never shown to anyone. While suspended, `/otp/request` still answers `202` as
  always, but the email sent is a fixed "Your account is suspended" notice instead of a code, so
  only the address holder learns of it; any request with a surviving session gets
  `403 SUSPENDED`.
- **Local-dev mode** (cookie name `sid` without `Secure`/`__Host-`, `console` email provider, the
  `/__dev/*` routes) is enabled only when the *parsed* `PUBLIC_URL` has scheme `http` and host exactly
  `localhost`, `127.0.0.1` or `[::1]`. Any other `PUBLIC_URL` with these settings ⇒ refuse to start.
  This single `isLocalDev(config)` predicate is the only switch for all dev behaviour.

Note: Safari's 7-day cap on script-writable storage does not apply to `HttpOnly` cookies set by the
same-origin server or to home-screen web apps, so long sessions are expected to survive on iOS.
Verify on a real device during M2.

## 5. Onboarding: display name and age

- **Age**: the onboarding screen asks the user to confirm they are at least `MIN_AGE` (config, an
  integer ≥ 13, default 13; operators in GDPR countries may set 16). The confirmation time and the
  `MIN_AGE` in force are stored (`users.age_attested_at`, `age_attested_min_age`). If the operator
  later raises `MIN_AGE`, every user whose `age_attested_min_age` is below the new value is
  **re-prompted**: `needsOnboarding` is true again and they get `403 ONBOARDING_REQUIRED` on the
  gated endpoints below until they confirm, but `onboarded_at` is never cleared, so the 7-day sweep
  never deletes them and their games carry on for the other players. Nothing else is collected
  about age. Children play through a parent's account (Q20); the privacy page
  says so (08 §5), and user-facing copy never markets the service to children.
- **"I'm under `MIN_AGE`"** is an explicit choice on the same screen (`POST /api/v1/me/under-age`,
  logged as `under_age_exit` without the email). It shows "Ask a parent or carer to sign in and
  play with you on their account." What happens next depends on the account:
  - **New account** (`onboarded_at` NULL): the account and its sessions are deleted at once, with
    no step-up code (04 §Account deletion, the short deletion). Invite emails to that address are
    suppressed and pending email seats for it become `inert`, so a child stops receiving
    invitations.
  - **Re-prompted account** (onboarded, re-prompted after a `MIN_AGE` rise): only **this session**
    is signed out; nothing is deleted. Children may be holding a parent's phone (Q20), so a child
    answering truthfully must never be able to delete the parent's account, and a stolen session
    must not skip the step-up for deletion (T5). The account holder can still delete the account
    through the normal step-up path (§7). The re-prompt copy addresses the account holder:
    "Please confirm you, the account holder, are `MIN_AGE` or older."

  An account that never completes onboarding (`onboarded_at` NULL) is deleted by the sweep 7 days
  after creation.
- **Display name**: prompted on the same screen. The screen warns: "Other players will see this.
  Don't use your full name." After onboarding it can be changed at most **3 times per 30 days**;
  each change is logged (`display_name_changed`), so a name can't be used as a rolling message
  channel. The same budget covers the user's AI accounts: renaming one, or creating one, uses one
  of the owner's 3 changes per 30 days (§8).
- **Until onboarding is complete** (`users.onboarded_at` NULL) the account is invisible to other
  players: it is treated exactly like an unknown address when someone adds that email (§6.1),
  claims no invitations, and gets `403 ONBOARDING_REQUIRED` from the game list, game creation,
  accept, join-link lookup and join, and from creating API tokens and AI accounts (05) — the
  **gated endpoints**, which also apply to a re-prompted user. Completing onboarding sets `onboarded_at` and claims email-invite seats (§6.4).

### 5.1 Display-name rules

- Normalise: Unicode NFC, trim, collapse runs of space separators to single spaces.
- 1–24 graphemes **and** ≤ 64 code points after normalisation; ≤ 2 combining marks per grapheme.
- Reject: control characters (tabs and line breaks included: refused, not collapsed), the
  Unicode line and paragraph separators (U+2028, U+2029),
  bidi override/isolate characters (U+202A–202E, U+2066–2069),
  zero-width characters (U+200B–200F, U+FEFF; the joiner U+200D only when it isn't between two
  emoji code points, so emoji sequences such as families and flags work), anything containing
  `://`, `www.` or `@`, anything
  that looks like a domain (`\p{L}\.\p{L}{2,}`, case-insensitive) or contains a run of ≥ 7 digits,
  and (case-insensitively) the configured `APP_NAME`, "admin", "support", "official", "staff".
  (Discourages spam via invite emails/push and impersonation.)
- Not unique. The UI disambiguates where needed (e.g. "Sam (2)" is *not* done; instead the start-game
  screen shows the email you typed, and the game list shows display names only).

## 6. Starting games and invites

Seat filling and the lobby are defined in 02 §4; this section covers identity and abuse rules.

1. **Adding players never reveals whether an email has an account** (Q3). The creator adds
   invitees by email or from past opponents (`userId`, which must be a past opponent). Each email is
   normalised and validated; the creator's own address → `CANNOT_PLAY_SELF`. Every other valid
   address gets a seat and an identical response (05 `POST /api/v1/games`):
   - an onboarded user → an invitation (§6.2), shown to them unless the pair has a block;
   - no account, or an account that hasn't finished onboarding → an email-invite seat (§6.3);
   - a block in either direction between that user and the creator **or any earlier invitee in the
     request or existing member** → an `inert` seat: never delivered, never claimable, expires with
     the lobby;
   - an address that resolves to a user **already added in the same request** (by `userId` or by
     another address) → an `inert` email-only seat with `user_id` NULL. Only literal duplicates (the
     same normalised address twice, or the same `userId` twice) are `INVALID_INVITEES`, so the
     response never confirms whose address it is.

   `userId` invitees are checked for blocks explicitly rather than relying on the past-opponent
   pair having been deleted. Only a block in either direction **between the creator and a `userId`
   invitee** fails the request, as `INVALID_INVITEES`, indistinguishable from "not a past
   opponent". A block between invitees (however each was added) or between an invitee and an
   existing member never changes the response: the later invitee in the request gets an `inert`
   seat, exactly as on the email path, so the response reveals neither whether a typed address has
   an account nor whether two other people have blocked each other.

   To limit typo invites, the players step shows each typed address back for confirmation before
   Create ("Check the address: …"). A row that has never been `joined` never shows a name or user
   id to anyone, in any state: while it's `invited` the creator sees the address they typed (or the
   name of a past opponent they picked); after a decline or removal the creator, like everyone
   else, sees only the state (05 §Common types). Response time doesn't depend on the case (same reads and writes, emails
   sent via `waitUntil`, as in §3.2). Per-pair limits (§6.7) count an email invitee by its
   `emailId`, never by the user it resolves to.
2. **Who can add me to games** (`users.settings.whoCanAddMe`, set in Settings):
   - `pastOpponents` (default): people I've finished a game with (04 `past_opponents`) can pick me
     from their list and I'm auto-joined and notified (push "<creator> added you to a game" +
     realtime). Everyone else — including a
     past opponent who types my email — sends me an **invitation**. A game with AI seats or with
     AI assistance allowed is always an invitation too, so I see the AI setup before I'm in
     (02 §4).
   - `nobody`: every game is an invitation, even from past opponents.

   (There's no "anyone" setting: adding by email must never auto-join, or the creator would learn
   that the address has an account.)

   An invitation is an `invited` seat with my `user_id`. It shows under *Invitations* in my game
   list with an in-app badge and a realtime update, plus a generic push that names nobody ("You have a new game invitation"), at most one per recipient per day — never
   the inviter's display name, the game or anything else they chose. If I have email nudges on,
   I get at most one email per invitation: a fixed "<Display Name> invited you to play <game name>"
   template, sent via `waitUntil` when the invitation is created (or claimed), category `nudges`
   (unsubscribe turns nudges off), counted toward the instance-wide invite-email cap (08 §4), never
   for `hidden` or `inert` invitations. I accept (`joined`) or decline; the invitation screen also
   offers **Block**. Invitations expire with the lobby.
3. Email-invite seats: `game_players.invite_email` set, `user_id` NULL, state `invited`. The game
   stays in `lobby` until all seats are joined or the creator starts it (02 §4). The invite email
   uses a fixed template, with no user-supplied free text other than display name:
   *"<Display Name> (<inviter email>) has invited you to play <game name> on <APP_NAME>."* + the turn
   timeout + a link to `PUBLIC_URL` + short "how to add to your home screen" + one-click
   unsubscribe ("Don't send me invites again", 05 §Email links). It isn't sent if the address is
   suppressed or over an invite cap (§6.6); the seat is created either way.
4. When a user **completes onboarding** (not merely verifies a code), every `invited`, non-`inert`
   email seat with matching `invite_email` in a `lobby` game where they hold no other row is
   claimed (guard, version check and retries in 02 §4): `user_id` set, `invite_email` kept for the
   creator's view until accepted. The seat becomes an invitation for the new user ("Sam invited you
   to play — Accept / Decline"), with the same checks as a new invitation:
   - the full §6.1 block rule against the creator **and every other row** in the game (a block in
     either direction → `inert`);
   - the inbound cap (§6.7; over it → `hidden`). The cap is counted once, when the game is created
     and for every typed address (§6.7); the claim reads the `delivery` stored on the seat then,
     and counts nothing again.

   An `inert` seat is never claimed and never becomes deliverable.

   A claim is a row-level update, not a game transition (02 §4): it doesn't bump the game version,
   sends no realtime event to other members and changes nothing the creator sees. The sweep (03 §8)
   also claims any matching seat it finds for an onboarded user, which covers a game created while
   the invitee was completing onboarding and any claim that failed.
5. Lobbies expire 14 days after creation → `expired`. When an email seat reaches any terminal
   state (accepted, game expired/cancelled/started without it, removed or declined), `invite_email`
   is cleared — we don't retain addresses the creator typed (the `invites` table keeps only the
   `emailId`).
6. Invite limits (abuse/spam control):
   - **Email invitees per creator**: 10 per day and 5 per hour (08 §4), counted for every typed
     email whatever it turns out to be, so the limit reveals nothing. Over the limit the
     whole request is `429` and nothing is created.
   - **Invite emails** (to addresses without an account): per inviter 5 / day and 20 / 30 days;
     accounts younger than 7 days **that have not yet completed a game** get 2 / day; per target
     address 3 invite emails / 30 days across all inviters (counted in `rate_limits` keyed by the
     email HMAC, so the count survives invite deletion); instance-wide caps in 08 §4. Over these
     limits, and for suppressed addresses, the seat is still created but **no email is sent** — the
     response doesn't change.
7. Game creation is also limited per pair (5 / day) and per user (30 / day), so a harasser can't
   spam declines-and-recreate. A **pair** is (creator, `userId`) for a picked past opponent and
   (creator, `emailId`) for every typed address, whatever it resolves to, so these limits (and the
   per-pair cap on `lobby`/`active` games, 05) behave the same for every address (Q3). **Inbound cap**: a user receives at most **1 invitation per day from
   any one creator** who isn't a past opponent, and **3 per day in total** from such creators. Over
   the cap the invitation is created with `delivery = hidden`: it goes to a collapsed *Hidden
   invitations* list (no badge, no push, no email), where the user can still accept or decline it,
   and it expires with the lobby. The cap is counted in `rate_limits` keyed by the target's
   `emailId` (with the creator's id for the per-creator count), for **every** typed address
   whatever it resolves to, with the same lookups and writes (Q3): a past opponent's invitation
   reads the counters without adding to them, and one already over the per-creator cap adds
   nothing to the total. The creator sees "Invited" either way. Active game caps (05) count
   only games a user *created*, so other people's games can never lock a user out of creating their
   own.
8. **Join links** (for groups, and for players who'd rather share a link in a group chat than type
   emails):
   - Created by the creator for a `lobby` game's open seats (seats not held by an `invited` or
     `joined` row); token = 128-bit random, stored only as SHA-256. The URL
     `PUBLIC_URL/join#<token>` carries the token in the fragment, so it never reaches server or
     proxy logs. It is shown only in the create/rotate response; afterwards the lobby shows "link
     active until …" with Rotate and Revoke.
   - Valid until the game starts, the creator revokes/rotates it, the lobby expires, or 7 days —
     whichever is first. Revocation or expiry never ends the lobby by itself (02 §4).
   - While a link is live, or once anyone has joined through one, the game never starts
     automatically: the creator sees who joined and presses Start (02 §4).
   - Joining requires being signed in and onboarded. A signed-out visitor signs up via OTP; the page
     keeps its own path and fragment in `sessionStorage` (only same-origin `/join` paths are
     accepted) and returns there afterwards. After reading the fragment the page calls
     `history.replaceState` to plain `/join`, so the token doesn't linger in browser history, and it
     clears the `sessionStorage` entry after a successful join or a `404`. Nothing ever joins
     automatically: the user always taps **Join**.
   - Refused with the indistinguishable `404` if the joiner has a block in either direction with the
     creator **or any current member**, if they declined or left this game, or if they were removed
     from it while this link was live (`removed_at ≥ join_links.created_at`; rotating the link
     lets the creator re-admit them). A user who already holds a `normal` or `hidden` invitation in
     the game accepts it by joining (`joined_via = invitation`); an `inert` row is never accepted.
   - A link join counts only against the joiner's own limits (lookup/join per user and per IP,
     08 §4), never against the creator's game caps.
   - The link reveals the game type, options, creator's display name and **joined** players'
     display names to anyone signed in who has it — the UI says so when creating one, and suggests
     sharing it only with people the creator knows.
9. **Past opponents** are recorded when a game finishes, for pairs who both took at least one
   action (04 `past_opponents`). A player who joined through a link is never recorded automatically;
   on the finished screen the creator is asked "Add <name> to your players?" and only a yes records
   creator ↔ that player, never the other players. So a forwarded link can't turn a stranger into
   anyone's past opponent without the creator's say-so. A pair with a block in either direction is
   never recorded — not at the finish, not through that question (`canAddPlayers` still lists a
   blocked link joiner, so the prompt reveals nothing, but `add-player` is then a silent `204`
   no-op that writes no pair) — and blocking someone deletes the relationship both
   ways. A test asserts that no `past_opponents` row ever exists for a blocked pair (04 invariant 6).
10. **Blocks** apply between every pair of users in a game: they're checked when seats are added
    (§6.1), on accept, on join, and again at start (02 §4). Blocking someone you share a lobby with
    takes effect at once: if you created it, their seat is removed; otherwise your own seat is
    declined or left (05 §Blocks). You can block anyone who is a past opponent or who holds or held a
    row in a game with you, including from the invitation screen.

Privacy note: with Q3 resolved, signed-in users can no longer learn whether an address has an
account from anything the server does on its own: responses, timing, limits, the lobby display,
removals, claims and hidden or inert delivery all look the same. The remaining signals need a real
person to act: someone **signs up** with the address and then **accepts** (the seat gains a name)
or **declines** (only an invitation can be declined, never an email-invite seat). These are accepted
residuals (08 T4).

## 7. Step-up: account deletion, tokens, admin

Some actions need proof that the account holder is present, not just a session: a fresh code sent
to the account's email (same OTP machinery and limits as sign-in, purpose-bound challenges, 04
`otp_challenges.purpose`). A stolen session alone can't do any of them.

- **Account deletion** (purpose `delete_account`): the client requests a code
  (`POST /api/v1/me/delete/otp`), then calls `DELETE /api/v1/me { code }`. Then → 04 §Account
  deletion. Sends a confirmation email afterwards. Immediate and irreversible (no grace period in
  v1); backups age out per the documented retention (09 §4).
- **Creating an API token** (purpose `token_create`, §8): the code is sent with the create
  request.
- **Creating an admin token** (purpose `token_admin`, §8, 05 §Admin API): a separate purpose, so a
  code obtained for one action can't be used for another.

Each purpose has its own email template that **names the action** ("Your code to delete your
account", "Your code to create an API token", "Your code to create an ADMIN token — if you didn't
ask for this, someone may be using your account"), distinct from the sign-in email, so a phished
code request is recognisable. Step-up code requests have their own rate limits (08 §4). There is no
cookie-based admin step-up in v1: admin access is by admin token only.

## 8. API tokens and AI accounts

Personal API tokens let a person's own tools — scripts, an MCP server, an AI agent (02 §9) — use
the public API without a browser session.

- **Format:** `ym_pat_` followed by an id and 256 random bits (base62), e.g.
  `ym_pat_<id>_<secret>`. The fixed prefix lets secret scanners recognise a leaked token: the project's gitleaks config includes a rule for it (CI and pre-commit, 11 §6). GitHub's and GitLab's own push protection won't recognise it unless the prefix is registered with them (GitHub's partner programme, or a GitLab custom pattern on a paid tier), so we don't rely on them.
- **Storage:** only `HMAC-SHA256(K_token, secret)` with the HKDF subkey `token/v1` (09 §1.1),
  compared in constant time after looking up the id. The token is shown once, at creation.
- **Creation:** in Settings, session only, by an **onboarded** user (not re-prompted, §5), with a
  `token_create` code (§7). The user picks a name (display-name rules, §5.1; the name is
  HTML-escaped in emails and never put in a subject line), scopes and an expiry of 1–365 days. At
  most 10 live tokens per account.
- **Scopes** (05 §Token scopes): `read` (always included); `play` — act on seats the user already
  holds (actions, resign, decline, seen); `games:create` — create and manage games the user
  creates, naming only past opponents and their own AI accounts, **never email invitees**; `join` —
  join links and accepting invitations. The app offers `read` + `play` by default and explains that
  an assistant should never need the other two. **`admin`** is exclusive: a token with it has no
  other scope, is for an admin acting as themselves only, expires within 1–30 days, needs a
  `token_admin` code, emails **every** admin when created, and is recorded in `admin_audit`.
- **What a token can't do:** create or revoke tokens, change settings or display name, manage
  sessions, push subscriptions or blocks, onboard, or delete the account. Those are session only
  (05 §Conventions).
- **Use:** `Authorization: Bearer …`. Bearer requests don't need `Origin` (they can't be forged
  cross-site) and must not also carry a session cookie. Per-token rate limits (08 §4) apply on top
  of the account's limits; `last_used_at` is updated at most once a minute. An unknown, expired or
  revoked token gets `401 UNAUTHENTICATED`; failures are counted per IP bucket like failed
  sign-ins.
- **Revocation:** from Settings at any time, by logout-all (when chosen, §4), by suspension
  (05 §Admin API) and by account deletion. Revocation takes effect on the next request; tokens hold
  no socket (WebSockets accept cookies only).
- **Notifications:** creating a token sends the account an email ("A new API token '<name>' was
  created for your account") so a hijacked session can't quietly mint one.

**AI accounts** (02 §9.2) are users with `kind = agent` and no email. They never sign in: the only
way to act as one is a token its owner created for it (same rules as above; only `read` and
`play`). Display-name rules (§5.1) apply, and the app shows it as "<owner>'s AI <name>" with a badge
wherever the name is shown, so an agent can't pass as a person and everyone knows whose it is.
Creating AI accounts needs an onboarded owner and is limited per day; each creation counts toward
the owner's rename budget (§5), so deleting and recreating agents can't be used to cycle names.
An AI account's tokens are refused (`401`) while its owner isn't onboarded (a new or re-prompted
owner, §5); its own onboarding state is derived from its owner's. An AI account is treated as its owner for block checks,
and can't be invited, picked, added or link-joined by anyone (§6). Owners see their agents'
tokens and games in Settings. An AI account is created already onboarded (`onboarded_at` set, no age
confirmation of its own — its owner's applies), receives no pushes or emails, and is suspended
and deleted together with its owner.
