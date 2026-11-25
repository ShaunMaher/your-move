# 07 — Frontend & PWA

React + TypeScript + Vite single-page app in `apps/web`. Mobile portrait first; desktop is a
centred column with a larger board.

The app is a **game shell** (02 §3): it owns sign-in, the game list, new-game flow, lobby, the
in-game frame (header, menu, history drawer, finished screen), settings and notifications. Each game
type's board UI is the `/client` entry point of an installed game package (02 §7), lazy-loaded
through the generated client import map (02 §7.3) the first time a game of that type is opened or
created. The service worker precaches the shell and runtime-caches module chunks.

The app talks to the server **only through `@your-move/api-client`** (05, 11 §5): the same typed
client, generated from the OpenAPI document, that other developers and the MCP server use. There
are no app-only endpoints.

## 1. Screens

| Route | Screen |
|---|---|
| `/signin` | Email entry → code entry (same screen, two steps) |
| `/welcome` | Onboarding (only when `needsOnboarding`, 06 §5 — for a new account, or a re-prompt after a `MIN_AGE` rise, which shows only the age step): display name with the "don't use your full name" warning, the age confirmation, and an explicit "I'm under `MIN_AGE`" choice (shows the parent/carer message; deletes a new account, but for a re-prompted account only signs out this session). The re-prompt is addressed to the account holder |
| `/` | Game list across all game types (each row: game icon, players, `summary`, last action): *Your turn* · *Invitations* (accept/decline/block) · *Waiting* (their turn, lobbies) · *Finished* (collapsed, with the end reason) · *Hidden invitations* (collapsed, no badge, fetched separately with `?invitations=hidden`, 06 §6.7); "New game" button |
| `/new` | New game flow (§1.1) |
| `/g/:id` | Lobby (status `lobby`: seats and their states, turn timeout, seat order, word list and other resources; rows never joined show the creator the typed address (or the picked past opponent's name) only while invited, and otherwise only their state ("Invited", "Declined", "Removed"), which is all everyone else ever sees; for the creator: join-link share sheet, Remove per seat, Start/Cancel; for an invitation: Accept/Decline/Block; for others: Leave) or the game frame + module `Board`. The history drawer pages through `GET /api/v1/games/:id/history`. The finished screen shows ranks (or "Declined — no result") and, for the creator, "Add <name> to your players?" for link joiners (02 §4) |
| `/join#<token>` | Join-link landing page: game type, options, turn timeout, creator and joined players; an explicit "Join" button. On load it reads the fragment and replaces the URL with plain `/join` (`history.replaceState`). Signed-out visitors sign in first; the path and fragment are kept in `sessionStorage` (same-origin `/join` only), restored afterwards, and cleared after a join or a `404` (06 §6.8). Never joins automatically |
| `/settings` | Display name, **who can add me to games** (06 §6.2), notifications toggle, email nudges, devices/sessions, sign out, sign out everywhere (with "also revoke all API tokens", checked by default), blocked players, delete account, about/licence/source link |
| `/settings/api` | **API tokens** (06 §8): list (name, scopes, acts as, created, expires, last used), create (name, scopes — `read` + `play` pre-selected, `games:create` and `join` behind an "advanced" toggle that explains an assistant never needs them; expiry; acting as me or one of my AI accounts; asks for a `token_create` step-up code; shows the token **once** with a copy button and a warning), revoke. Admin tokens aren't created here: admins use the same screen's separate "Admin token" form (exclusive scope, ≤ 30 days, its own step-up code). **AI accounts** (02 §9.2): create (display name), rename, delete, see their games. Links to the OpenAPI document (`/api/v1/openapi.json`) and the MCP guide |
| `/privacy` | Privacy page (08 §5), operator contact from config; says the service is for people aged `MIN_AGE`+ and that children play through a parent's account, and that the email provider keeps copies of sent emails (sign-in codes, invitations) and for how long (operator-configured text) |
| `/settings/word-lists` | My uploaded word lists: upload (file picker → name, language, rights checkbox → progress), list with "in use by N games", delete |
| `/help/word-lists` | "Where can I get a word list?" (words §9.5): official sources only, licence reminder, accepted file format |
| `/install` | Short illustrated "Add to Home Screen" guide (shown as a dismissible banner on iOS Safari when not standalone) |

The app name comes from `/api/v1/config` at runtime; nothing name-specific is baked into the build.

**AI labels** (02 §9.2, 08 T31): wherever a player's name appears — game list, lobby, header,
history, finished screen, invitations, the join page — an AI account shows "<owner>'s AI <name>"
with an AI badge (icon + accessible label "AI player"), from the envelope's `kind` and
`aiOwnerName` (05). Moves made through a token show an "AI" marker in the history drawer (from
`via`). Games with AI assistance allowed show it in the header, lobby, invitation and join page.

There is no admin UI in v1; operators use the Admin API and its command-line client (09 §1.2).

### 1.1 New game flow

1. **Game**: one card per enabled game type (icon, name, player range). Preselected: the last game
   type the user created.
2. **Options**: the module's `OptionsForm` with this module's `catalog`, prefilled from
   `catalog.games[].defaults` (the user's last choices for that game type). For `words`:
   - **Ruleset** cards: name, one-line description, key numbers (tiles, bingo bonus), and a small
     preview of the premium layout.
   - **Word list** select: only dictionaries compatible with the chosen ruleset. Built-in and
     operator lists come first, then "Your uploads", then an "Upload a word list…" entry that links
     to `/settings/word-lists`.
3. **Players**: seat count stepper, shown only when the game allows more than one count. Pick past
   opponents, or type emails. Typed addresses are shown back before Create ("Check the address:
   sam@example.org") because the app never says whether an address has an account (06 §6.1, Q3);
   a typo just becomes an invitation nobody receives. There's also an "Add a join link for the
   open seats" toggle (with the warning that anyone with the link can see the game and join, and
   that the game then waits for you to press Start), and a "Turn order: join order / random"
   choice.
   If the creator has AI accounts, they can add them to seats here ("Add my AI"); for a game type
   with hidden information this is offered only when every other seat is one of their AIs (02 §4).
4. **Pace and AI**: turn timeout in days (1–30), defaulting to the game's `defaultTurnTimeoutDays`;
   **AI assistance** off / allowed (02 §9.3), defaulting to off whenever a seat is open or two or
   more people will play (02 §4), fixed once created, with a one-line explanation ("Allowed: players
   may let their own AI agent make moves; those moves are marked").
5. **Create**. The game starts immediately if every seat is filled by auto-joined past opponents
   and/or the creator's own AIs, there's no join link and no AI rule prevents it (02 §4); otherwise
   it opens the lobby. If a join link was created, its URL is shown once with a share
   button.

In the game frame, the menu shows the game's name and options (e.g. ruleset and word list), plus
the module's `RulesSheet`.

## 2. Word game board layout (portrait phone) — `games/words/client`

(The `paths` board is described in games/paths.md §8. Header, menu and history drawer are provided
by the shell for every game.)

```
┌─────────────────────────────┐  safe-area top
│ You 212  •  Sam 187   ⋯     │  score bar, whose turn, menu (history, swap, pass, resign)
├─────────────────────────────┤
│                             │
│        15×15 board          │  square, fills width; pinch / double-tap to zoom
│                             │
├─────────────────────────────┤
│  +24  QUIZ ✓                │  live preview: score + validity
│ [A][E][R][?][T][S][N]       │  rack: 7 tiles, ≥ 44 pt targets (≥ 40 pt below 360 pt width)
│ ⟲ shuffle   ↩ recall  PLAY  │  actions
└─────────────────────────────┘  safe-area bottom
```

- On a 375-pt-wide phone each board square is ~24 pt, too small to place accurately, so:
  - **Zoom**: the board supports pinch-zoom and double-tap-to-zoom around a point, implemented in
    the app (CSS transform), not browser zoom. When a tile is being dragged over the unzoomed
    board, the board auto-zooms around the finger after a short hover (≈ 300 ms).
  - **Tap-to-place alternative**: tap a rack tile to select it, then tap a square. Required for
    accessibility and for users who dislike dragging.
- Drag and drop uses Pointer Events with `touch-action: none` on board/rack, a drag ghost offset
  above the finger so the target square is visible, and snapping to the nearest empty square.
- Placed-but-uncommitted tiles can be dragged back to the rack or to another square; "Recall"
  returns all.
- Blank tile: dropping a `?` opens a letter picker grid (A–Z).
- Rack order is the player's choice and persists locally per game (localStorage, best effort).
- Premium squares show short labels (DL/TL/DW/TW) plus colour; colours are not the only signal.
- Last move's tiles are highlighted; tapping a word on the board shows its score in the history.
- Submit button disabled when the client engine says the play is invalid; the server still
  validates.
- After submit: optimistic "submitting" state; on `409 STALE_GAME` or `409 NOT_YOUR_TURN` refetch
  and keep the tentative tiles on the rack.

## 3. Engine use on the client (word game)

The `words` client imports `@your-move/game-words/engine` (with every ruleset bundled) and the dictionary lookup to compute:
placement validity, words formed, score, bingo. The game's own `rulesetId@version` and
`dictionaryId` are used. This mirrors the server exactly (same code). For `serverOnly`
dictionaries the client computes placement and score locally and gets word validity from the
debounced preview endpoint (05). Until validity is known (either way),
previews show score only.

## 4. PWA requirements

- `manifest.webmanifest`: **served by the server at runtime** (03 §9) with `name`/`short_name` from
  `APP_NAME`/`APP_SHORT_NAME`, `display: "standalone"`, `start_url: "/"`, `scope: "/"`,
  `orientation: "portrait"` (Android only; iOS ignores it — the layout must not break in landscape,
  it may simply centre the portrait column), `theme_color`, `background_color`, icons 192/512 +
  maskable. The build emits no manifest of its own.
- iOS specifics:
  - `<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">`
  - `<meta name="apple-mobile-web-app-capable" content="yes">` and
    `apple-mobile-web-app-status-bar-style`
  - `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
    and layout padding via `env(safe-area-inset-*)`.
  - Prevent accidental page zoom / rubber-banding on the board area only; don't disable zoom on
    text screens (accessibility).
  - Web Push only works once installed to home screen (iOS 16.4+); the notifications toggle explains
    this when running in Safari.
- Service worker (`apps/web/sw/sw.js`, emitted as `/sw.js` by a small Vite plugin that prepends the
  build's file list — a hand-written worker rather than Workbox, so the basics need no dependency;
  a prompt-style update, registered from the app's own script after load — an external file, never
  inline, for CSP):
  - Precache the app shell and hashed assets.
  - Runtime cache dictionary assets (cache-first, versioned URLs, at most the 3 most recently used
    dictionaries kept).
  - **Never cache `/api/*`** responses (network-only).
  - `navigateFallbackDenylist: [/^\/api\//, /^\/__dev\//, /^\/manifest\.webmanifest$/]` so
    server-rendered pages (the unsubscribe page lives at `/api/v1/email/unsubscribe`, 05) are never
    replaced by the SPA shell.
  - Show "New version available — reload" toast when an update is waiting.
  - `push` handler MUST call `showNotification` for every push (iOS revokes subscriptions that
    receive silent pushes). `notificationclick` focuses an existing window or opens `/g/:id`.
  - Safari has no `pushsubscriptionchange`, so on every app launch the client re-reads
    `pushManager.getSubscription()` and re-POSTs it if present (idempotent upsert).
- CSP compatibility (08 §3): no inline scripts or styles in the production build;
  `build.assetsInlineLimit: 0` (no `data:` fonts/scripts); the theme-flash-prevention snippet is an
  external file. Vite's dev server gets its own relaxed dev-only CSP, never shipped. Playwright
  fails any test on a `securitypolicyviolation` event.
- Offline: the shell loads and shows "You're offline"; viewing the last-fetched game list from
  memory is nice-to-have, not required. No offline move queueing in v1.
- Placeholder icons are generated programmatically (a neutral geometric glyph, not tied to any one
  game) so there's no dependency on a name or logo.

## 5. Visual design

- Original look — must not imitate any commercial game's colours, tile style or board artwork.
- Light and dark themes following `prefers-color-scheme`, with a manual override in settings.
- CSS custom properties for all colours/sizes so theming later is trivial.
- Respect `prefers-reduced-motion` (no tile fly-in animations).
- Haptics: none (not available to iOS web apps); use subtle visual feedback instead.

## 6. Accessibility

- Shell: lobby seats, invitations, deadlines and rankings have text equivalents; the game header
  announces whose turn it is.
- Word game: every square has an accessible name ("Row 8, column 8, double word, empty" / "…
  letter Q, 10 points").
- Path game: squares, edge notches, hand tiles and rotations have accessible names (games/paths.md
  §8).
- Full keyboard play on desktop (word game: arrow keys to move cursor, type letters from rack, Enter
  to submit, Backspace to recall; path game: arrow keys to choose a hand tile, R to rotate, Enter to
  place).
- Contrast ≥ WCAG AA for text and premium labels.

## 7. Testing

- Component tests with Vitest + Testing Library.
- Playwright e2e on WebKit and Chromium at iPhone-sized viewports: sign-in (OTP captured from the
  dev email sink), create game, play first move, opponent sees update, finish a scripted game.
