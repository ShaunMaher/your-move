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
[Enter code]  --POST /otp/verify-->  server verifies, creates user if new, creates session, claims invites
   ├─ onboarding incomplete → [Display name + age confirmation] → PATCH /me → [Game list]
   └─ otherwise             → [Game list]
```

## 3. One-time codes

- 6 digits, generated with CSPRNG and rejection sampling (uniform 000000–999999).
- Stored only as `HMAC-SHA256(K_otp, challengeId ‖ code)` where `K_otp` is the HKDF subkey
  `otp/v1` (09 §1); compared in constant time.
- Valid for **10 minutes**, **single use**, max **5 verify attempts** per challenge (then the
  challenge is burned).
- Up to **3 live challenges** per email may exist; a verify is checked against each live
  challenge (newest first, each check consuming one attempt on that challenge). Issuing a 4th
  burns the oldest. This prevents an attacker invalidating the victim's freshly received code by
  requesting another (sign-in DoS).
- Rate limits (all via `rate_limits`, full table in 08 §4; IP bucketing rules in 08 §4.1):
  - per email: 5 code requests / hour, 10 / day; 10 failed verifies / hour across challenges.
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
  attempts < 5 AND consumed_at IS NULL AND expires_at > ? RETURNING code_hash`. Zero rows ⇒ treat as
  invalid.
- On match: `UPDATE otp_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`. Only
  the request that changes 1 row proceeds to create a session and claim invites.
- Rate-limit counters: `INSERT ... ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
  RETURNING count`, then compare. Limits use two adjacent fixed windows weighted (sliding-window
  approximation) to avoid double bursts at window boundaries.
- M2 acceptance includes a test firing 50 parallel verifies at one challenge: at most 5 are
  evaluated and at most 1 succeeds, on both drivers.

### 3.2 Timing parity (MUST)

- `/otp/request` performs the same DB operations on every path (known/unknown email, limited/not)
  and always sends email via `waitUntil` after responding — never awaited in the request.
- `/otp/verify` computes an HMAC against a dummy key/value when no live challenge exists.
- M2 includes a loose statistical timing test for both endpoints.

### 3.3 Email and input

- Email: subject `"<code> is your <APP_NAME> sign-in code"`; body repeats the code, says it expires
  in 10 minutes, "We will never ask you for this code — don't share it with anyone", "If you didn't
  request this, ignore this email", and the approximate request time. A link to the app is fine;
  it must not carry the code.
- Input field: `inputmode="numeric"`, `autocomplete="one-time-code"`, `pattern="[0-9]*"`,
  paste-friendly (strip spaces/dashes).
- Optional, operator-configurable: Cloudflare Turnstile on `/otp/request` (works on both targets).
  Off by default; enabling it is a documented exception to the "no third-party client resources"
  rule (CSP gains `script-src`/`frame-src https://challenges.cloudflare.com`; privacy page updated).

### 3.4 Guessing odds

Per targeted email: ≤ 10 failed verify requests / hour, each tested against ≤ 3 live codes ⇒
≤ 720 code guesses / day ⇒ ≈ 0.07 % chance per day for 6 digits (and the attacker must keep the
victim's account supplied with live challenges, which the victim sees as unsolicited code emails).
Across many targets the binding limits are per-IP-prefix (08 §4.1) and the global breaker: at most
≈ 500 failed verifies/hour instance-wide before Turnstile engages ⇒ ≤ 1,500 guesses ⇒ ≈ 0.15 %
expected takeovers per hour of sustained attack, which is loud (alerts) and then throttled.
Accepted for v1; moving to 8 digits is a one-line change and is the first lever if monitoring shows
pressure.

## 4. Sessions

- On successful verify: generate a 256-bit random token, store `SHA-256(token)` in `sessions`, and
  set cookie:
  `__Host-sid=<token>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000` (400 days, the
  browser maximum).
- Sliding expiry: session valid for **180 days since last use**; `last_seen_at` refreshed at most
  once per hour per session to limit writes. Absolute cap 400 days, then re-verify.
- Session tokens are rotated on sign-in only (no privilege changes exist that would need rotation).
- Logout deletes the session row and clears the cookie; logout-all deletes all rows for the user.
- **Revocation is complete**: deleting a session (logout, logout-all, revoke from the sessions list,
  account deletion) also deletes push subscriptions bound to it (FK cascade, 04) and closes its live
  WebSockets (the server publishes a `session.revoked` control message to the user's realtime
  channel; sockets are tagged with their session id and closed with code `4401`). Sockets also have
  a 24 h maximum lifetime, so a missed revocation can't outlive a day (03 §6).
- On sign-out the client also unsubscribes its push subscription and clears per-game local state
  (rack order) — shared devices.
- **Local-dev mode** (cookie name `sid` without `Secure`/`__Host-`, `console` email provider, the
  `/__dev/*` routes) is enabled only when the *parsed* `PUBLIC_URL` has scheme `http` and host exactly
  `localhost`, `127.0.0.1` or `[::1]`. Any other `PUBLIC_URL` with these settings ⇒ refuse to start.
  This single `isLocalDev(config)` predicate is the only switch for all dev behaviour.

Note: Safari's 7-day cap on script-writable storage does not apply to `HttpOnly` cookies set by the
same-origin server or to home-screen web apps, so long sessions are expected to survive on iOS.
Verify on a real device during M2.

## 5. Onboarding: display name and age

- **Age**: the onboarding screen asks the user to confirm they are at least `MIN_AGE` (config,
  default 13; operators in GDPR countries may set 16). The confirmation time is stored
  (`users.age_attested_at`). A user who can't confirm sees: "Ask a parent or carer to sign in and
  play with you on their account." Nothing else is collected about age. Children play through a
  parent's account (Q20); the privacy page says so (08 §5), and user-facing copy never markets the
  service to children.
- **Display name**: prompted on the same screen; changeable later. The screen warns: "Other
  players will see this. Don't use your full name." No game can be created or joined until
  onboarding is complete (`403 ONBOARDING_REQUIRED`).

### 5.1 Display-name rules

- Normalise: Unicode NFC, trim, collapse internal whitespace to single spaces.
- 1–24 graphemes **and** ≤ 64 code points after normalisation; ≤ 2 combining marks per grapheme.
- Reject: control characters, bidi override/isolate characters (U+202A–202E, U+2066–2069),
  zero-width characters (U+200B–200F, U+FEFF), anything containing `://`, `www.` or `@`, anything
  that looks like a domain (`\p{L}\.\p{L}{2,}`, case-insensitive) or contains a run of ≥ 7 digits,
  and (case-insensitively) the configured `APP_NAME`, "admin", "support", "official", "staff".
  (Discourages spam via invite emails/push and impersonation.)
- Not unique. The UI disambiguates where needed (e.g. "Sam (2)" is *not* done; instead the start-game
  screen shows the email you typed, and the game list shows display names only).

## 6. Starting games and invites

Seat filling and the lobby are defined in 02 §4; this section covers identity and abuse rules.

1. The creator adds invitees by email or from past opponents (`userId`, which must be a past
   opponent). For each email the server normalises it and checks:
   - self → `CANNOT_PLAY_SELF`; a block in either direction with the creator **or any other
     invitee in the request** → `CANNOT_CHALLENGE` (doesn't say who).
   - existing user → handled per §6.2.
   - unknown → `404 NOT_A_PLAYER { emails }`. Client shows: *"<email> isn't playing yet. Send them
     an invite? They'll see your name and email address."* → resubmit with `invite: true`.
2. **Who can add me to games** (`users.settings.whoCanAddMe`, set in Settings):
   - `anyone`: anyone who knows my email can add me; I'm auto-joined and notified (push + realtime).
   - `pastOpponents` (default): people I've finished a game with (04 `past_opponents`) auto-join me;
     anyone else sends me an **invitation**.
   - `nobody`: every game is an invitation, even from past opponents.

   An invitation is an `invited` seat with my `user_id`. It shows under *Invitations* in my game
   list with an in-app badge and a realtime update, but **never a push**; if I have email nudges on,
   I get at most one email per invitation. I accept (`joined`) or decline. Invitations expire with
   the lobby.
3. Email-invite seats: `game_players.invite_email` set, `user_id` NULL, state `invited`. The game
   stays in `lobby` until all seats are joined or the creator starts it (02 §4). The invite email
   uses a fixed template, with no user-supplied free text other than display name:
   *"<Display Name> (<inviter email>) has invited you to play <game name> on <APP_NAME>."* + the turn
   timeout + a link to `PUBLIC_URL` + short "how to add to your home screen" + one-click
   unsubscribe ("Don't send me invites again", 05 §Email links).
4. When anyone verifies an OTP for that email, every `invited` email seat with matching
   `invite_email` in a `lobby` game is claimed: `user_id` set, `invite_email` cleared. The seat then
   follows §6.2 for the new user — with the default setting and no past opponents, that's an
   invitation they see right after onboarding ("Sam invited you to play — Accept / Decline"). If it
   auto-joins and fills the game, the game starts (02 §4). Claims are server-initiated transitions
   with retries (02 §4).
5. Lobbies expire 14 days after creation → `expired`. When an email-invite seat reaches any terminal
   state (game expired/cancelled/started without it, removed or declined), `invite_email` is
   cleared — we don't retain non-users' addresses (the `invites` table keeps only the `emailId`).
6. Invite limits (abuse/spam control): per inviter 5 / day and 20 / 30 days; accounts younger than
   7 days **that have not yet completed a game** get 2 / day; per target address 3 invites / 30 days
   across all inviters (counted in `rate_limits` keyed by the email HMAC, so the count survives
   invite deletion); instance-wide caps in 08 §4. Suppressed addresses are never emailed (the API
   response doesn't reveal this).
7. Game creation against existing users is also limited per pair (5 / day) and per user (30 / day),
   so a harasser can't spam declines-and-recreate to push their name to someone's lock screen.
   **Inbound cap**: a user receives at most 3 invitations per day from creators who aren't past
   opponents (counted across all creators). Over the cap the invitation is created `suppressed`: the
   target never sees it, the creator sees "Invited" as usual, and it expires with the lobby. Active
   game caps (05) count only games a user *created*, so other people's games can never lock a user
   out of creating their own.

8. **Join links** (for groups, and for players who'd rather share a link in a group chat than type
   emails):
   - Created by the creator for a `lobby` game's open seats (seats not held by an `invited` or
     `joined` row); token = 128-bit random, stored only as SHA-256. The URL
     `PUBLIC_URL/join#<token>` carries the token in the fragment, so it never reaches server or
     proxy logs. It is shown only in the create/rotate response; afterwards the lobby shows "link
     active until …" with Rotate and Revoke.
   - Valid until the game starts, the creator revokes/rotates it, the lobby expires, or 7 days —
     whichever is first.
   - Joining requires being signed in. A signed-out visitor signs up via OTP; the page keeps its own
     path and fragment in `sessionStorage` (only same-origin `/join` paths are accepted) and returns
     there afterwards. Nothing ever joins automatically: the user always taps **Join**.
   - Refused with the indistinguishable `404` if the joiner has a block in either direction with the
     creator **or any current member**, if they declined or left this game, or if they were removed
     from it while this token was live (rotating the link lets the creator re-admit them).
   - Link joins count toward the per-pair/per-user game limits; `/api/join/lookup` and `/api/join`
     are rate-limited per user and per IP (08 §4) to stop token guessing.
   - The link reveals the game type, options, creator's display name and joined players' display
     names to anyone signed in who has it — the UI says so when creating one, and suggests sharing
     it only with people the creator knows.
9. **Past opponents** are recorded when a game finishes (04 `past_opponents`). A player who joined
   through a link is recorded only with the creator, never with the other players, so a forwarded
   link can't turn a stranger into everyone's past opponent. Blocking someone deletes the
   relationship both ways.

Privacy note: the "isn't playing yet" response tells an authenticated user whether an email address
has an account. This is inherent to the requested UX. It is mitigated by requiring sign-in,
rate-limiting lookups (30 / hour / user, counted on both outcomes), and logging. See open question
Q3 for the alternative.

## 7. Account deletion

Step-up required: the client requests a fresh code (`POST /api/me/delete/otp`, same OTP machinery
and limits, purpose-bound challenge), then calls `DELETE /api/me { code }`. A stolen session alone
cannot delete the account. Then → 04 §Account deletion. Sends a confirmation email afterwards.
Immediate and irreversible (no grace period in v1); backups age out per the documented retention
(09 §4).
