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
  `ym.install-dismissed` flag (07 §4): per device, no user data, and kept across sign-out on
  purpose, the `ym.push-offered` flag (07 §4, alpha A8) and the `ym.theme` copy of the theme choice (07 §5, alpha A9), for the same reasons. The device's
  push subscription does not survive: `clearClientState()` unsubscribes it in the browser (the
  server already deleted its row with the session), and so does a launch that finds no session,
  beside clearing the game keys (the return path is kept, as above).
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
  of the owner's 3 changes per 30 days (§8). A request that sets only the name while another
  request completes onboarding is judged as a name set before onboarding and isn't counted as a
  rename: an accepted residual, at most once per account (alpha A21 review S2-1).
- **Until onboarding is complete** (`users.onboarded_at` NULL) the account is invisible to other
  players: it is treated exactly like an unknown address when someone adds that email (§6.1),
  claims no invitations, and gets `403 ONBOARDING_REQUIRED` from the game list, game creation
  (a rematch included), accept, join-link lookup and join, creating or rotating a join link, the
  recent-players list, `add-player`, turning email nudges on, and from creating API tokens and AI
  accounts (05) — the **gated endpoints**, which also apply to a re-prompted user (alpha A21;
  `add-player` since A19 review S-2; join-link creation and email nudges since A21 review S-5,
  S-1: either brings new people or new email to the account). Everything that keeps existing games
  going stays open: reading them, moves, start, cancel, resign, decline, remove seat, revoking a
  link, and turning nudges off. Completing onboarding sets
  `onboarded_at` and claims email-invite seats (§6.4). The display name and the age confirmation
  may come in one `PATCH /api/v1/me` or in two, in either order; the request that leaves both
  done completes onboarding. A name set before then is not a rename (no budget used, nothing
  logged), and a re-prompted user sends the age confirmation alone.
- **Under-age exit and onboarding racing**: the short deletion applies only while `onboarded_at`
  is still NULL, checked in the same atomic batch that deletes; if onboarding completed first, the
  exit is judged again for the account as it now is (a re-prompt: this session signed out;
  onboarding no longer needed: `409 WRONG_STATUS`). Completing onboarding is judged the same way
  on the stored row, in the batch that writes the answers (`onboarded_at` set only while NULL and
  both answers are stored), so two requests each bringing one answer still complete it, and a
  request that finds the account gone (the exit won) answers `401` and claims nothing (alpha A21
  review S-2).

### 5.1 Display-name rules

- Normalise: Unicode NFC, trim, collapse runs of space separators to single spaces.
- 1–24 graphemes **and** ≤ 64 code points after normalisation; ≤ 2 combining marks per grapheme.
- Reject: control characters (tabs and line breaks included: refused, not collapsed), the
  Unicode line and paragraph separators (U+2028, U+2029),
  bidi override/isolate characters (U+202A–202E, U+2066–2069),
  zero-width characters (U+200B–200F, U+FEFF; the joiner U+200D only when it isn't between two
  emoji code points, so emoji sequences such as families and flags work), anything containing
  `://`, `www.` or `@`, anything
  that looks like a domain (`\p{L}\.\p{L}{2,}`, case-insensitive) or contains 7 or more digits anywhere, counted with separators ignored and after NFKC folding, so circled, superscript and full-width digits count too (`555 123 4567`, `5-5-5-1-2-3-4`, `①②③④⑤⑥⑦`; alpha A17 review S-4, S2-4; applied when a name is set, never to stored names),
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

   Picked (`userId`) invitees are seated before typed addresses, whatever their order in the
   request (alpha A12): "already added" and "earlier invitee" above always put a picked invitee
   before every typed one, so a typed address can only ever get the `inert` seat itself and never
   changes how a picked one is seated (which the creator would see, since an auto-join shows as
   `joined`). **A request that picks two or more past opponents makes every pick an invitation**
   (Q29, settled by alpha A23 with its option (e)): no pick is auto-joined, whatever its
   `whoCanAddMe`, so a block between two picks changes nothing the creator sees: the later one's
   invitation is `inert` instead of `normal`, and both show as invited. A request with a single
   pick may auto-join it (§6.2); its only block check is with the creator, which is refused as
   above. Nothing else the creator can observe differs either: an `inert` pick is counted toward
   the per-pair limits and the live-game cap exactly as a `normal` one (by (creator, `userId`)),
   never toward the inbound cap, and spends the shared invite-email caps only on the never-read
   `silent` counters, as every unmailed pick does (§6.6).

   To limit typo invites, the players step shows each typed address back for confirmation before
   Create ("Check the address: …"). A row that has never been `joined` never shows a name or user
   id to anyone, in any state: while it's `invited` the creator sees the address they typed (or the
   name of a past opponent they picked); after a decline or removal the creator, like everyone
   else, sees only the state (05 §Common types). Response time doesn't depend on the case (same reads and writes, emails
   sent via `waitUntil`, as in §3.2). Per-pair limits (§6.7) count an email invitee by its
   `emailId`, never by the user it resolves to.
2. **Who can add me to games** (`users.settings.whoCanAddMe`, set in Settings):
   - `pastOpponents` (default): people I've finished a game with (04 `past_opponents`) can pick me
     from their list and I'm auto-joined and notified (when I'm their only pick: a request picking
     two or more makes every pick an invitation, §6.1) (push "<creator> added you to a game" +
     realtime; when the game starts at creation and it's my turn, the one push says "<creator>
     added you to a game. Your turn.", 03 §7). Everyone else — including a
     past opponent who types my email — sends me an **invitation**. A game with AI seats or with
     AI assistance allowed is always an invitation too, so I see the AI setup before I'm in
     (02 §4).
   - `nobody`: every game is an invitation, even from past opponents.

   Decision (alpha A12 review S2-2): a creator who picks someone whose setting is `nobody` sees that
   seat as invited rather than joined, which reveals that person's global preference to their past
   opponents. That is acceptable: it says nothing about an address or a block, and Q29's
   settlement (every pick an invitation when a request picks two or more) hides it in group games.

   (There's no "anyone" setting: adding by email must never auto-join, or the creator would learn
   that the address has an account.)

   An invitation is an `invited` seat with my `user_id`. It shows under *Invitations* in my game
   list with an in-app badge and a realtime update, plus a generic push that names nobody ("You
   have a new game invitation"), at most one per recipient per day — never the inviter's display
   name, the game or anything else they chose. If I have email nudges on,
   I get at most one email per invitation: a fixed "<Display Name> invited you to play <game name>"
   template, sent via `waitUntil` when the invitation is created (a claim sends only the push,
   below), category `nudges`
   (unsubscribe turns nudges off), counted toward the instance-wide invite-email cap (08 §4), never
   for `hidden` or `inert` invitations. I accept (`joined`) or decline; the invitation screen also
   offers **Block**. Invitations expire with the lobby.

   Precisely (alpha A20). An invitation here is a `normal` `invited` row with a `user_id`: a typed
   address of an onboarded user, a past opponent picked when their `whoCanAddMe` is `nobody` or the
   game allows AI assistance (02 §4), or a claimed email-invite seat (§6.4).
   - **The push** is sent in the background after the response, on alpha A8's sender (03 §7): body
     "You have a new game invitation.", `url` `/` (the game list, where *Invitations* are), `tag`
     `invitation`, so one notification stands for however many arrived. It reads the game when it
     is sent and pushes only to invitees whose row is still a `normal` invitation in a `lobby`. The
     daily limit is a counter per recipient in the fixed UTC day (`INVITATION_PUSHES_USER_DAY`,
     08 §4), taken in the background only for a recipient with a live subscription and only the
     first one in the day is sent; nothing in the request reads or writes it, so it says nothing
     to a creator (Q3).
   - **The email** (`invitationNudgeEmail`) goes only to an onboarded human with
     `settings.emailNudges` true and `email_id` set, not suspended or being deleted, whose address
     has no `email_suppressions` row of any reason (an `unsubscribed` row is the address's own
     "don't send me invites", which this email is). Turning email nudges on in Settings is the
     holder's own opt-in and deletes their address's `unsubscribed` row, never a `bounced` or
     `complained` one (review A20-P-3, 04). Subject and first line: "<Display Name>
     invited you to play <game name> on <APP_NAME>"; then a link to `PUBLIC_URL` (the invitation is
     in the game list), why it was sent, and the Settings link and the `nudges` one-click
     unsubscribe with its headers (05 §Email links); never the game's id, options, state or other
     players, nor any address. For a typed address it is built, counted and scheduled exactly like
     the invite email (§6.3, §6.6): "may be mailed" in §6.6's tiers covers this email too, so it is
     sent only when the inviter's caps, the per-address cap and the instance-wide cap all passed,
     and `invites.sent_at` records it. Strangers' invitations can use up a nudged user's 3 in 30
     days, so a later invitation sends no email; the push still arrives (accepted residual F-24,
     review A20-S-3). A picked invitee isn't a typed address: it counts nothing
     toward the inviter's caps, and the shared caps under its real keys (its `email_id`) only when
     it may be mailed, the `silent` counter otherwise, so the work doesn't depend on its setting.
   - A claim (§6.4) sends the push, never the email: the seat's one email was the invite email
     decided when the game was created (§6.3), so "at most one email per invitation" holds and no
     cap is passed twice.
3. Email-invite seats: `game_players.invite_email` set, `user_id` NULL, state `invited`. The game
   stays in `lobby` until all seats are joined or the creator starts it (02 §4). The invite email
   uses a fixed template, with no user-supplied free text other than display name:
   *"<Display Name> (<inviter email>) has invited you to play <game name> on <APP_NAME>."* + the turn
   timeout + how long the invitation stays open (the lobby's 14 days) + how to join (sign in at
   `PUBLIC_URL` with this address: a link to `PUBLIC_URL` that carries nothing else, a sign-in code
   by email, a display name, then the invitation waits in the game list) + short "how to add to
   your home screen" + one-click unsubscribe ("Don't send me invites again", 05 §Email links:
   purpose `invites`, the address's `emailId`, with the `List-Unsubscribe` headers). The subject is
   *"<Display Name> invited you to play <game name> on <APP_NAME>"*. Nothing else about the game:
   never its options, state or other players (alpha A17). Until turn timeouts exist (they aren't in
   the alpha, 10) the email leaves the turn timeout out rather than promise a limit nothing
   enforces. It is built for **every** typed address (the same work whatever the address turns out
   to be, §6.1) and sent via `waitUntil` after the response, only for an email-invite seat with
   `normal` delivery whose address isn't suppressed (any reason, 04 `email_suppressions`) and
   that passed every invite cap (§6.6). A seat the inbound cap made `hidden` (§6.7) is never
   mailed, exactly like a suppressed address (review A17-P-1): it would otherwise reach the person
   with no badge and no list entry to match. The seat is created either way. The `invites` row's
   `sent_at` is set by that background task once the sender has accepted the email, never before
   the response; a failed send leaves it NULL.
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

   Precisely (alpha A17): the `PATCH /api/v1/me` that completes onboarding claims before it
   answers, so the new user's game list already shows the invitations (unread: the row keeps the
   `last_seen_version` of -1 it was created with). It claims at most a per-runtime number of seats,
   oldest lobby first (Node 50, the Worker 8, sized by the Worker's per-request query budget,
   09 §3; review A17-S-5); the sweep's claim step claims any beyond that on its next runs (03 §8),
   so an address with more seats than the cap gets the rest within a sweep or a few. A claim
   that fails there is logged by error class and never fails onboarding; the sweep claims it
   later. A lobby at or past its expiry is never claimed into (it is about to expire, 02 §4). A
   claim that makes a `normal` invitation sends the claimant the generic invitation push (§6.2;
   alpha A20), in the background after the
   onboarding response or from the sweep, and never the invitation email. At onboarding the
   claimant has usually just signed in and has no push subscription yet, so that push is normally
   a no-op (review A20-P-6); the sweep's claim is the one that usually reaches a device.
5. Lobbies expire 14 days after creation → `expired`. When an email seat reaches any terminal
   state (accepted, game expired/cancelled/started without it, removed or declined), `invite_email`
   is cleared — we don't retain addresses the creator typed (the `invites` table keeps only the
   `emailId`).
6. Invite limits (abuse/spam control):
   - **Email invitees per creator**: 10 per day and 5 per hour (08 §4), counted for every typed
     email whatever it turns out to be, so the limit reveals nothing. Over the limit the
     whole request is `429` and nothing is created.
   - **Invite emails** (to email-invite seats: no account, or one that hasn't finished
     onboarding; and, since alpha A20, the invitation email to a user with nudges on, §6.2): per
     inviter 5 / day and 20 / 30 days;
     accounts younger than 7 days **that have not yet completed a game** (have no past-opponent
     row, §6.9: a finished game in which both players acted) get 2 / day; per target
     address 3 invite emails / 30 days across all inviters (counted in `rate_limits` keyed by the
     email HMAC, so the count survives invite deletion); instance-wide caps in 08 §4. Over these
     limits, and for suppressed or `hidden` seats (§6.3), the seat is still created but **no email
     is sent** — the response doesn't change. They are counted in two tiers, the same way for
     every typed address (alpha A17 review S-1):
     1. the **inviter's** caps (a day, 30 days, the new-account rate) count **every** typed address
        as one attempt, whatever it resolves to — an onboarded user, no account, an un-onboarded
        account, a suppressed address, a `hidden` seat — so how much allowance an address uses up
        reveals nothing about it, and the inviter, the only one who can observe these caps, learns
        nothing from them. Inviting existing players by address therefore uses up the inviter's
        invite-email allowance too;
     2. the **shared** caps (per target address, instance-wide) count under their real keys only an
        address that may be mailed (an email-invite seat with `normal` delivery, not suppressed;
        since alpha A20 also a `normal` invitation of a user who gets the invitation email, §6.2)
        and passed the inviter's caps; every other address adds 1 to the never-read `silent`
        counter of each instead (§3.2), so addresses that would never be mailed can't spend another
        address's or the instance's budget;
     3. the email is sent only when every cap passed, and never once the instance-wide cap has
        been crossed in the current fixed UTC day: from its crossing (marked when its alert is
        logged) to the end of that day nothing is sent, whatever the sliding estimate says
        later, so an instance held at the cap answers a probe at most about once a day
        (review A17-S2-1; the residual is accepted risk F-20).

     Every typed address therefore writes the same number of counters and schedules the same
     background task. Known residual (review A17-P-13): for a mailed address the per-target row
     is typically inserted, while an unmailed one updates the long-lived `silent` row, so the
     database work differs as an insert differs from an update; nothing of it is visible through
     the API, and the statistical timing suite covers the timing class (ADR 0006). The background
     task's own work differs by address too (an email sent or not; since alpha A20 the invitation
     push and its daily counter): on Workers it runs in the request's `waitUntil`, after the
     response; on Node it shares the server's event loop, so a creator's next request can wait a
     little longer behind a send than behind nothing. That residual (review A20-S-6) needs the
     creator to time their own following requests against an email provider's or push service's
     latency; nothing of it is in any response.
7. Game creation is also limited per pair (5 / day) and per user (30 / day), so a harasser can't
   spam declines-and-recreate. A **pair** is (creator, `userId`) for a picked past opponent and
   (creator, `emailId`) for every typed address, whatever it resolves to, so these limits (and the
   per-pair cap on `lobby`/`active` games, 05) behave the same for every address (Q3).
   **Inbound cap**: a user receives at most **1 invitation per day from any one creator** who
   isn't a past opponent, and **3 per day in total** from such creators. Over the cap the
   invitation is created with `delivery = hidden`: it goes to a collapsed *Hidden invitations*
   list (no badge, no push, no email), where the user can still accept or decline it, and it
   expires with the lobby. Since alpha A20 (review S-1, which fixes F-17) the cap counts **live
   invitations**, not creations: the `invites` rows for the target's `emailId` in games created
   in the last 24 hours, from creators who aren't past opponents of the user the address belongs
   to. The per-creator count takes the creator's rows of any delivery but `inert`; the total takes
   `normal` ones. A row stops counting when its lobby ended unplayed (`cancelled`, `expired`, or
   `declined` by someone else) or its seat was `removed`, so throwaway lobbies can't push a real
   invitation into *Hidden*; the target's own decline keeps it counting, so declining doesn't
   invite a re-invitation, and so does a game that started. Each `invites` row has its seat's
   `game_players.id` as its id (04), which is how a removal is seen. It is one read per typed
   address, the same statement whatever the address resolves to (a placeholder user when there is
   none), and writes nothing (Q3). The read isn't serialised with the insert, so creations racing
   for one target all read the same count: one stranger racing their own creations can get up
   to the pair limit (`GAMES_CREATED_PAIR_DAY`, 5 a day) of `normal` invitations to that target,
   and any number of strangers can race at once. The notices stay bounded (one invitation push a
   day, 3 emails to an address in 30 days); only the target's list grows. Serialising the check
   inside the create batch is M4's (10; review A20-P2-2, S2-1). The creator sees "Invited" either
   way. Active game caps (05) count only games a user *created*, so other people's games can never
   lock a user out of creating their own.
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
     automatically: the creator sees who joined and presses Start (02 §4). Whether a game starts by
     itself is judged only in the transition that accepts an invitation (a join through a link never
     starts one); revoking or rotating a link, or its expiry, is no transition and never starts a
     game, which then waits for the creator's Start or the next accept.
   - Joining requires being signed in and onboarded. A signed-out visitor signs up via OTP; the page
     keeps its own path and fragment in `sessionStorage` (only same-origin `/join` paths are
     accepted) and returns there afterwards. After reading the fragment the page calls
     `history.replaceState` to plain `/join`, so the token doesn't linger in the tab's session history
     (the browser's own history database may still have recorded the visit: an accepted residual,
     docs/security/findings.md F-23), and it
     clears the `sessionStorage` entry after a successful join or a `404`. Nothing ever joins
     automatically: the user always taps **Join**.
   - Refused with the indistinguishable `404` if the joiner has a block in either direction with the
     creator **or anyone else holding a row in the game** (joined, invited, declined, left or
     removed alike, 05), if they declined or left this game, or if the creator removed them from
     it: a removal sticks across links, so no join link brings them back, neither a rotated one nor
     a new one after a revoke or expiry (the creator can play with them in another game:
     cancel this one and create a new one, inviting them by address or as a past opponent; alpha
     A18 review S-3). A user who already holds a `normal` or `hidden` invitation in
     the game accepts it by joining (`joined_via = invitation`); an `inert` row is never accepted, and
     its holder gets the same `404`. The checks read the same rows for every outcome, so the
     answer's work doesn't say which reason refused it.
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
   no-op that writes no pair; what follows it can still show the block, an item open for M4 in
   08 T20) — and blocking someone deletes the relationship both
   ways. A test asserts that no `past_opponents` row ever exists for a blocked pair (04 invariant 6).
10. **Blocks** apply between every pair of users in a game: they're checked when seats are added
    (§6.1), on every accept, on join, at a claim (§6.4), and again at start (02 §4). You can block
    anyone who is a past opponent or whose row in a game with you has been joined (05 §Blocks: a
    row never joined never counts, Q3), from a lobby (07). Blocking deletes the past-opponent pair
    both ways (§6.9). Games already under way carry on: a block never changes an `active` or ended
    game.

    In the same batch, every open invitation the person blocked holds in a lobby you have joined
    (or created) becomes `inert` (alpha A23 review S-2): a versionless row write listed in 03 §5.2
    (no version bump, nothing for the creator or other members to see, since the three deliveries
    look alike), so for them the invitation is gone exactly as if they had been removed, and it can
    never be accepted. Where you are only invited yourself, nothing changes yet (review P2-2):
    your own accept, or your link join, makes their open invitation in that game `inert` in its
    own transition (review S3-1), so whichever of you accepts second finds the game gone, as after
    a Remove; if they accept first, your accept's check finds the block and declines yours.

    Then, where you can already tell their row is theirs (their row has been `joined`, which the
    lobby shows by name, or you created the lobby and picked them by `userId`): if you created the
    lobby, their seat is removed; otherwise your own seat is declined. Each is written exactly as
    the creator's Remove or your own Decline would be (02 §4: its own transition, the same state and
    version bump, and the lobby can end `declined` the same way). It is declined rather than `left`
    even for a joined seat, because the lobby's own Decline is how a joined player leaves today
    (07 §1) and a `left` row would mark the block. Where the other person holds only an invitation
    you can't attribute, nothing visible changes: acting on it would tell you who that row is, and
    a creator would learn which typed address is whose (Q3). Where the call's per-runtime lobby
    limit left an effect unwritten, the lobby's next Start or accept writes it first, as its own
    transition by you (your Decline) or by you as creator (your Remove), and that Start or accept
    answers `409 STALE_GAME` with nothing of its own written (02 §4 step 1, review S2-3). A join
    link refuses either of you; its batch's guard checks joined members only, since an invited row
    is kept apart by its own accept check (review P2-10).

    What can still be noticed (accepted residuals, F-26, 08 T20): the past-opponent pair is gone,
    so each disappears from the other's "People you've played" and a pick between them is
    refused, which tells the one who didn't block that the other did; and when you block, from
    their invitation, a past opponent who invited you by typing an address, the pair's
    disappearance also tells them that address reached your account. Blocking several co-members
    at once declines several lobbies at once, a pattern a creator who shares them could notice.
    Two people comparing what they see (a join link, an invitation that vanished) can infer that a
    block involves one of them (as T24). An accept that races a block reads as an invitation gone,
    like a Remove. Unblocking lifts the block only: deleted pairs stay deleted and `inert` seats
    stay `inert` (alpha A23).

11. **Rematch** (alpha A15, 05 `POST /api/v1/games/:id/rematch`). Any player of a `finished` game
    may ask for its rematch; it is created as if they had picked every other player of that game by
    `userId` in `POST /api/v1/games`, so every rule above applies to it unchanged (the past-opponent
    and block checks of §6.1, `whoCanAddMe` of §6.2, the limits of §6.7) and nothing is checked
    differently. Everyone involved already shared that game and knows who else played, so no
    address is ever involved and no address-to-account link can arise. What each caller can observe:
    - **Not a player of the game** (never seated, or a stranger guessing ids): `404 NOT_FOUND`, the
      same code, body and reads as `GET /api/v1/games/:id` gives a non-member, before anything is
      created or counted; only the per-user write limit every write counts applies. It never says
      whether a rematch exists.
    - **A player whose fellow player has since blocked them, or is suspended or being deleted, or
      joined by link and was never added**: `400 INVALID_INVITEES`, before any limit is counted —
      exactly what picking that person in `POST /api/v1/games` answers, for every one of those
      reasons alike. It reveals nothing new: the same person has already left (or never joined) the
      caller's "People you've played" list (`GET /api/v1/players/recent`), for the same set of
      reasons. So in a game with a link joiner only its creator can start the rematch, and only
      after adding them (§6.9): adding pairs the joiner with the creator alone, by design, so
      every other player's rematch stays `INVALID_INVITEES`, and so does the joiner's own while
      the game has another player who isn't their past opponent (alpha A19).
    - **A player whose fellow player's account was deleted, or who never acted in that game**
      (declined, or resigned or timed out before a first action): that person isn't carried over,
      and the rematch has one seat fewer. When too few people remain for the game, the answer is
      `409 REMATCH_UNAVAILABLE`, before any limit is counted. Both depend only on what every player
      of the finished game already sees: "Deleted player" on its finished screen, and who acted in
      its public history.
    - **The rematch itself** is shown to every player of the finished game (`rematch`, 05), with
      only their own place in it: joined, invited, or neither. A rematch that ended unplayed
      (any declined ending, or cancelled or expired before any action, but never an operator's
      cancel; 04 `rematch_game_id`) shows as no rematch (`null`) and may be replaced;
      its status is one every member of it saw, and any player could have pressed Rematch anyway. An `inert` invitation (a block
      between two carried-over players, the later of them seated so, Q29) shows to its holder as
      `none` from the moment the rematch exists, like any row that gives no access, so they are
      offered no Accept that would fail; to them it reads like an immediate Remove. The other
      players see their row as invited, as for every invitation (Q29, alpha A23). The holder can
      still learn of the rematch from the other players, and that they aren't in it: the residual
      of people comparing answers (08 T24).
    - Status codes, error codes, caps and their timing class are those of `POST /api/v1/games` (and
      of `POST …/accept` for the accept), whatever the other players' states. Two simultaneous
      presses yield one game; the loser's own daily creation counters were already counted (its
      own limits only, bounded by the write limit), an accepted cost.

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
  deletion. Sends a confirmation email afterwards, counted toward the instance-wide OTP email caps
  (08 §4.2); over either cap the confirmation is skipped, since it only informs, and the account is
  deleted all the same. Immediate and irreversible (no grace period in v1); backups age out per the
  documented retention (09 §4).
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
