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
| `/g/:id` | Lobby (status `lobby`: seats and their states, turn timeout, seat order, word list and other resources; rows never joined show the creator the typed address (or the picked past opponent's name) only while invited, and otherwise only their state ("Invited", "Declined", "Removed"), which is all everyone else ever sees; for the creator: join-link share sheet (making a new link or turning it off while one works is confirmed first), Remove per seat, a status of how many of the seats have joined, Start/Cancel; for an invitation: Accept/Decline/Block; for others: Leave) or the game frame + module `Board`. The history drawer pages through `GET /api/v1/games/:id/history`. The finished screen shows ranks (or "Declined — no result") and, for the creator, "Add <name> to your players?" for each person in the envelope's `canAddPlayers` (02 §4, alpha A19), with **Add** (`POST /api/v1/games/:id/add-player`; on `204` the question gives way to "Added <name> to your players.", the same whether or not a block stopped the pair, since that `204` is silent, and the screen refetches) and **Not now** (hides the question on this screen only: it comes back on the next visit, or when Rematch is refused for want of the people listed). While anyone listed hasn't been added on this screen and the button reads "Rematch", a line under it says what a rematch needs ("To rematch, first add <names> to your players."), and Rematch refused with `INVALID_INVITEES` then says "Add them to your players first, then press Rematch again." instead of the general text below. Beside "Back to games", a finished game (status `finished` only) shows one rematch button from the envelope's `rematch` (05): "Rematch" while it is null (also once a rematch ended unplayed, which may be replaced), "Accept rematch" when you hold an invitation in it, "Go to rematch" when you've joined it, and none when you're in it no longer (alpha A15). Each calls `POST /api/v1/games/:id/rematch` (it is disabled while the call runs, reading "Starting rematch…", "Joining rematch…" or "Opening rematch…" respectively) and opens the game it answers; a refusal is shown under the buttons: the limits with the new-game flow's texts (§1.1), and the rest with texts of their own, since there is no form to go back to ("Someone from this game can't be added any more. Start a new game with the people you can play."; "This game's options aren't available to you. Start a new game instead."; `REMATCH_UNAVAILABLE`: "Too few players from this game are left to play it again."). After a `404` or `409` the screen refetches the finished game, so the button matches what the server now says |
| `/join#<token>` | Join-link landing page: game type, options (the word list; a module options summary is future work), turn timeout, turn order, creator and joined players; an explicit "Join" button, or for someone already in the game "You're in this game" with Open (the lookup's `youAreIn`), and "Not now", which forgets the link. On load it reads the fragment and replaces the URL with plain `/join` (`history.replaceState`). Signed-out visitors sign in first (and someone signed in who hasn't finished onboarding onboards first); the path and fragment are kept in `sessionStorage` (same-origin `/join` only), restored afterwards, and cleared after a join or a `404` (06 §6.8): the fragment in an entry of its own, which only a well-formed `/join#<token>` fills, while the sign-in screens' return path is plain `/join`, so the token never returns to the address bar or the history; the entry also goes when the session ends in the tab. Never joins automatically. Shows the AI-assistance setting and, before Join, that the game waits for its creator to start it |
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
   opponents, or type emails. Past opponents (`GET /api/v1/players/recent`) are listed by display
   name, each with "last played <date>" (the device's locale) as secondary text, as a checkbox
   group with the legend "People you've played" (rows at least 44 pt tall; once every seat is
   filled, the unpicked ones are disabled and the note under the group says "Every seat is filled;
   unpick someone to choose another."); each pick fills one seat and removes one address field,
   an empty one first, unpicking gives it back, and lowering the seat count drops the latest
   picks. The list isn't shown when it's empty or couldn't be loaded. The review step
   shows each pick as "Playing with <name>" (alpha A12). Any player who has joined a lobby and isn't its creator
   sees Decline there, the lobby decline of 02 §4, so a player added this way (who never chose to
   join) can leave before the start. Under the address fields a note says what happens to a typed
   address without saying whether it has an account (alpha A17): "We'll email them an invitation
   from you, showing your name and email address. If they already play on <APP_NAME>, it waits
   in their list of games instead. Either way, you'll see them as invited until they accept." (so
   the inviter's address is disclosed before it is sent, 08 §5). Typed addresses are shown back
   before Create ("Check the address:
   sam@example.org") because the app never says whether an address has an account (06 §6.1, Q3);
   a typo sends the invitation to someone else. There's also an "Add a join link for the
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
│ You 212  •  Sam 187   ⋯     │  score bar and whose turn; the shell's menu (history, rules, resign)
├─────────────────────────────┤
│                             │
│        15×15 board          │  square, fills width; pinch / double-tap to zoom
│                             │
├─────────────────────────────┤
│  +24  QUIZ ✓                │  live preview: score + validity
│ [A][E][R][?][T][S][N]       │  rack: 7 tiles, ≥ 44 pt targets (≥ 40 pt below 360 pt width)
│ shuffle recall swap pass PLAY│  actions (the board's own)
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
- Blank tile: placing a `?` on a square (by drop or by tap) opens a letter picker grid (A–Z);
  dismissing it takes the blank back to the rack.
- Rack order is the player's choice and persists locally per user and game (`localStorage`, best
  effort), under the reserved key `ym.game.words.<userId>.<gameId>` that the shell wipes at
  sign-out (02 §3, 06 §4). Only the permutation (positions in the sorted rack) is stored, never
  letters; it is written only after the player reorders (shuffle or drag), never on mount, and
  removed when the game is no longer active.
- Premium squares show short labels (2L 3L 2W 3W) plus colour and a pattern: letter squares in
  green with an inset border, word squares in violet with diagonal stripes; the start square shows
  a diamond. Colours are not the only signal, and every text and background pair meets WCAG
  contrast (4.5:1 text, 3:1 other parts; a unit test computes them).
- Last move's tiles are highlighted (a corner notch as well as colour), and the line above the
  board names the move. Tapping a word on the board to see its score is the history drawer's, a
  shell feature of the alpha's A4 slice and M3, not the module's.
- Submit button disabled when the client engine says the play is invalid; the server still
  validates.
- **Whose turn it is is plain at a glance** (alpha A10). A turn chip under the scores says "Your
  turn" (a filled chip in a strong colour, larger text) or, quietly, "Sam's turn" (several seats:
  "Waiting for Sam and Alex"); it is absent when the game isn't under way or nobody is to act. The
  seat or seats to act are a filled chip in the score list (the underline stays as a second cue;
  `aria-current` names them to assistive technology). The chip is the board's one announcement of a
  change of turn (`role="status"`, filled in place so the change is read when it happens, not on
  every render); the status line doesn't repeat the turn, though it may follow with its own short
  hint (two brief announcements at a change of turn are accepted). The shell's frame bar, drawn
  only where there is no board, words it the same way: "Your turn", "Sam's turn" for one waiting
  seat, "Waiting for Sam and Alex" for several. A dialog open on the board closes when a new
  version of the game arrives or the turn passes, and nothing is sent off turn.
- **Planning off turn** (alpha A10). With a rack in an active game a player may place tiles while
  it is not their turn. Such tiles are a plan, not a move: they are drawn as **planned tiles** (a
  paler tile with a dashed outline; the letter keeps its own contrast pair, never reduced
  opacity), named "Planned tile E, 1 point, not your turn, not played", and the status line says
  "Not your turn yet. Tiles you place now are only a plan." The local engine analysis still
  shows, so a planner sees what the plan would score and why tiles can't go where they are (the
  score and words, or the placement rule's text). When the board has the game's public word list
  (§3), the plan's words are also checked against it, exactly as on the player's turn ("All words
  are in the word list." or the words that aren't), because it costs nothing and helps planning;
  with no list they aren't checked. Either way there is no "Checking the words…", no `preview`
  request and nothing else sent, and Play, Swap and Pass stay disabled. Recall, Shuffle and moving the tiles work as usual. When the turn
  becomes theirs, the same tiles become ordinary placements in place, and the word
  check starts. When a new version of the game takes a planned tile's square, the tile goes back
  to the rack; no tile is lost or overlaps another.
- **Dragging a tile off the board returns it** (alpha A13). A tile the player may move (this
  turn's placed tiles, or planned tiles off turn) that is let go anywhere that is not a square of
  the board goes back to the rack: outside the grid, over the page or the scores, or off-screen.
  The place it is let go is where the release event says it is. A returned tile goes to the end of
  the rack (as "Return tile to rack" and Backspace/Delete on a focused square do), unless it is let
  go on the rack, which keeps the position it is dropped at. A cancelled pointer (a system
  gesture, say) returns the tile only if the ghost was in its off-board state at that moment;
  cancelled over the board, the tile stays on the square it was lifted from. A blank loses its
  chosen letter. Over a square, a drop is unchanged (moving, or snapping to the nearest empty
  square). Tiles from earlier turns can't be picked up, and a tile dragged from the rack and let go off the board stays on the rack. While the pointer
  is off the board the ghost is drawn as a plain rack tile with an ink ring, not as a placed or
  planned one, to say that letting go returns it. Every return, by drag, button or key, is
  announced in the status line ("Tile S returned to the rack."). No rule changes: it is only a
  shorter way to do what the keyboard path (select the tile, "Return tile to rack") already does.
- **No-play hint** (alpha A14, words §10.8). On the player's turn, when the client's exhaustive
  search over their own rack, the board and the game's `public` word list proves that no word can
  be played, the status line says "No word can be played with your tiles. Try swapping some." (the
  bag holds at least the ruleset's `swapMinBag`) or "No word can be played with your tiles. You can
  pass." in place of "Place tiles to make a word.", announced by its live region. It runs once per
  game version in slices that yield to the browser, never off turn or while a tile is pressed or
  dragged; when the search can't finish within its step limit, or there is no `public` list, it
  says nothing. Play stays available and nothing is done automatically.
- **Swap and Pass are board controls**, each a dialog on the board (swap: pick the rack tiles, with
  the reason when the bag is too small; pass: confirm). **Resign is the shell's menu** (02 §3): the
  module's `Action` has no resign, and the shell's `resign` call is not part of `BoardProps`.
- The board does not wait for a word-list download to show a score: the placement rules and the
  score come from the engine's view-level analysis at once; whether the words are valid comes from
  `preview` (below), debounced (250 ms) and shown when it answers, and Play stays enabled meanwhile
  (the server still validates).
- After submit: optimistic "submitting" state; on `409 STALE_GAME` or `409 NOT_YOUR_TURN` refetch
  and keep the tentative tiles on the rack.

## 3. Engine use on the client (word game)

The `words` client imports `@your-move/game-words/engine` (with every ruleset bundled) and the dictionary lookup to compute:
placement validity, words formed, score, bingo. The game's own `rulesetId@version` and
`dictionaryId` are used. This mirrors the server exactly (same code). For `serverOnly`
dictionaries the client computes placement and score locally and gets word validity from the
debounced preview endpoint (05). Until validity is known (either way),
previews show score only. The module itself never downloads a list: holding and caching the list
for public dictionaries is the shell's job. The shell hands the game's public list to the board as
`resources.dictionary` (02 §3), and the board uses it for the no-play hint (words §10.8) and for
previews (alpha A16): when the list's id is the game's own dictionary's, the board computes
the whole preview locally with the engine's own code, the same score, words, bingo and error
codes in the same check order as the server's `preview` (words §10.5), instantly and with no
request. When there is no list, the id differs, or the local computation fails, the board asks the
shell's `preview` (the server) as before; a local answer is never shown that the server could
contradict, and Play still goes through `submit`, where the server remains authoritative.

## 4. PWA requirements

- **Browser baseline** (01 §6): iOS and iPadOS Safari 16.4 or later, and current Chrome, Firefox
  and Safari. That is the floor for constructable stylesheets (`document.adoptedStyleSheets`),
  which game client modules rely on under the CSP (02 §3). A browser below it gets a visible
  "Please update your browser to play" instead of a broken page.
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
  - **Notifications (alpha A8).** Settings has a "Notifications" section for this device: a "Notify
    me on this device" toggle where push can work, and otherwise one line saying what stands in the
    way — the instance sends none (no `vapidPublicKey` in `/api/v1/config`), iOS or iPadOS Safari
    outside the Home Screen (the A7 Safari test and not standalone; it links to `/install`), a
    browser without service workers, the Push API or notifications, or notifications blocked for the
    site (allow them in the browser or device settings). Turning it on calls
    `Notification.requestPermission()` straight from the tap, before anything is awaited (iOS
    honours a permission request only inside a user gesture), then `pushManager.subscribe({
    userVisibleOnly: true, applicationServerKey })` and the POST; if the POST fails the browser
    subscription is undone, so the toggle never shows "on" for a device the server doesn't know. A
    dismissed prompt leaves it off; a refused one shows the blocked line and moves focus to the
    section's heading, since the toggle that had it is gone. Turning it off sends the DELETE, then
    unsubscribes the browser. **After the first game is created** (never at sign-in, 03 §7) the
    new-game flow offers it once per device, before going to the game: "Know when it's your turn?"
    with "Turn on notifications" (the same tap rule) and "Not now", either of which goes on to the
    game. The same offer follows a successful **Accept** of an invitation, on the game's screen
    (Q28), and focus then moves to the screen's heading; the offer is made only when the instance
    has a key, the device could subscribe, permission is still `default` and the per-device
    `localStorage` key `ym.push-offered` isn't set (it is set when the offer shows; guarded like
    `ym.install-dismissed`, and outside the `ym.game.` prefix, 06 §4). At each launch with a session
    the client saves an existing subscription again (below); one made with a VAPID key the server no
    longer has is unsubscribed and replaced with one for the current key. Sign-out, and a launch
    that finds no session, unsubscribe the browser (06 §4).
  - **Install guide** (alpha A7). `/install` is a signed-in screen (a signed-out visit is remembered
    and restored like any other, §6): numbered steps for iOS Safari (Share, which is at the bottom
    on iPhone and the top right on iPad, behind the three-dot button when it isn't shown; "Add to
    Home Screen"; Add, leaving "Open as Web App" on if iOS shows it), a short note for Android
    Chrome (menu, "Install app") and, when the app already runs standalone, only an "already
    installed" message. Its pictures are original glyphs drawn in the page's own markup (never an
    image file, `dangerouslySetInnerHTML` or anyone's artwork), each step also saying in words what
    the icon looks like. The guide says Safari is the most reliable, and that other iPhone browsers
    (iOS 16.4+) may offer Add to Home Screen in their own share menu.
  - **Install banner.** A dismissible banner, linking to `/install`, shows on the game list, the
    new-game screen and Settings (signed in, onboarded) when the browser is Safari on iOS or iPadOS
    (a user agent with `Version/` and `Safari/` and without the token of another iOS browser or an
    in-app browser; iPadOS reporting a Mac is recognised by touch support) **and** the app is not
    standalone (`navigator.standalone` or `(display-mode: standalone)`); it never shows in the
    installed app. The banner stays Safari-only. It is not shown on the sign-in screens (the person
    has not decided to stay yet), on `/install` itself or on a game's screen, which keeps the whole
    viewport for the board and leaves the update toast's corner free. It sits in the page flow above
    the screen, never fixed. Dismissal is a per-device `localStorage` key, `ym.install-dismissed`,
    outside the `ym.game.` prefix so it survives sign-out (06 §4); every read and write is guarded,
    so with storage unavailable the banner shows again on the next load and nothing breaks.
    Dismissing moves focus to the screen's `h1`. Settings links to `/install` as well, so the guide
    stays reachable after a dismissal.
- Service worker (`apps/web/sw/sw.js`, emitted as `/sw.js` by a small Vite plugin that prepends the
  build's file list — a hand-written worker rather than Workbox, so the basics need no dependency;
  a prompt-style update, registered from the app's own script after load — an external file, never
  inline, for CSP):
  - Precache the app shell (`/`) and every file the build emitted except source maps. The build
    hashes the content of each precached file (the HTML and the public files too) into the cache
    name, so a change to any of them is a new version.
  - Hashed assets: cache first, else the network. The worker adds nothing to its own cache at
    runtime. The **word-list cache** (`dictionaries-v1`, the 3 most recently *added* lists, in the
    order Cache Storage keeps its keys; the lists of the game being opened are never evicted for
    it) is written by the page, not the worker (alpha A4): when a game is open the shell downloads
    each list whose resource says `distribution: "public"` from the envelope's `downloadUrl`
    (only a same-origin `/assets/dictionaries/…` path of the served shape is fetched, without
    credentials and refusing redirects), stores it only if its content hashes to the digest in its
    own file name, and the worker's clean-up of old shell caches leaves it alone. A resource
    without `distribution: "public"` is never fetched, whatever else it carries. Downloads run one
    at a time. The game's own list (its one resource of kind `dictionary`; with none or several,
    nothing), when it is public, is then opened for the board as `resources.dictionary` (02 §3).
    Its bytes are hashed, and its text put through the word-list check (lower-case `a`–`z`
    words, sorted; about 30 ms on a laptop for the built-in list), once: as they are downloaded,
    and only a list that passes both is stored, or as they are read back from this cache, where
    an entry that fails either is deleted and downloaded again once. The opened list is kept by
    its URL, which names its content, so every game with that list gets the same object; the
    three most recently used are kept. It is held as the list's sorted text (about one byte a character, 1.7 MB for
    the built-in list) with binary-search lookups and nothing built. A failed download, a digest
    that doesn't match, a text that isn't a word list, no Cache Storage, or a list that isn't
    public hands nothing over, and the board goes on without it. Without it previews
    answer from the server; with it the board previews locally (§3).
  - **Alpha refresh rates** (no realtime yet, 10 Alpha), only in a visible tab and also on focus
    and when the tab becomes visible: an open game polls every 5 s while it waits on someone else
    (a lobby, or another player's turn); the game list polls every 15 s whether or not anything
    is waiting, so a new invitation appears by itself. A hidden tab polls nothing and marks
    nothing seen.
  - **Never touch server-handled paths**: the worker ignores non-GET requests, other origins and
    every path in `SERVER_PATHS` (`@your-move/shared`, the one list also behind the server's 404s
    and, by hand, Cloudflare's `run_worker_first`; 03 §9): `/api/*`, `/__dev/*` and
    `/manifest.webmanifest`. They go straight to the network, so server-rendered pages (the
    unsubscribe page lives at `/api/v1/email/unsubscribe`, 05) are never replaced by the SPA
    shell, and API responses are never cached. An e2e test checks, for both players of a game, that no `/api/` response comes
    from the worker and that Cache Storage holds the precache list plus, in `dictionaries-v1`
    only, entries of the served word-list shape (`/assets/dictionaries/<id>-v<n>.<16 hex>.txt`).
  - Navigations go to the network first (a new deployment shows at once) and fall back to the
    cached shell when the network fails or has not answered within 4 seconds; with no shell the
    request fails.
  - Show "New version available — reload" toast (an always-present live region) when an update is
    waiting. The new worker activates only when the person agrees, and then **every open tab
    reloads** (a tab that was controlled by the old worker reloads when the controller changes):
    the old cache is deleted on activation, so a tab left on the old code would find its files
    missing. The cost is that a second tab reloads without being asked, so **unsent input in
    other tabs is lost** (a half-typed code or name, a tentative move not yet saved to the
    device); it only happens after the person chose to update in the first.
  - `push` handler MUST call `showNotification` for every push (iOS revokes subscriptions that
    receive silent pushes). `notificationclick` focuses an existing window or opens `/g/:id`.
    As built (alpha A8): the push's JSON `{ title, body, url, tag }` becomes a notification with
    the app icon, `data.url` and, with a tag, `renotify: true`; a payload that can't be read still
    shows a fixed "Game update" / "Something happened in one of your games." (the worker doesn't
    know `APP_NAME`). Only a game's path (`/g/<id>`, no further `/`, query or fragment) is ever
    opened; anything else opens `/`. A tap with a window of the app open posts
    `{ type: "open", path }` to it and focuses it, and the page's router moves there without a
    reload (it accepts only a game's path, from its own origin); with none open it opens the
    path.
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
- Light and dark themes following `prefers-color-scheme`, with a manual override in settings
  (alpha A9): Settings → Appearance is a group of three radios (System, Light, Dark), saved at
  once as `settings.theme` (04, 05): the choice shows and applies immediately, the radios stay
  enabled so focus stays on the group, and a failed save puts the old theme back with the
  usual problem message. Light or Dark sets `data-theme="light"` or `"dark"` on the page's
  root element; System removes it, and the dark tokens then apply under
  `prefers-color-scheme: dark` unless `data-theme` is `"light"`. Every dark rule in the shell's CSS
  follows the same override, and `color-scheme` follows it too, so form controls match. The app's
  own module applies the choice (no inline script, 08 §3): as soon as `/api/v1/me` answers, and
  from a per-device copy in `localStorage` (`ym.theme`, guarded like the install flag; storage that
  throws counts as System) read when the module starts, so a launch doesn't flash the other
  theme. The copy is a display preference with no user data, so it survives sign-out (06 §4) and
  is rewritten whenever the server's answer differs. A game's own board palette is its module's
  business and does not change.
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
- After a move to another screen, focus goes to its `h1` (`tabIndex={-1}`), unless the screen has
  focused a field of its own. Error and notice regions are live regions that are always in the
  page, so what fills them is announced.
- A signed-out visit to an app path is remembered for the sign-in (in `sessionStorage`, a
  same-origin absolute path only, never `/signin` or `/welcome`), and signing in lands there; an
  explicit sign-out forgets it.

## 7. Testing

- Component tests with Vitest + Testing Library.
- Playwright e2e on WebKit and Chromium at iPhone-sized viewports: sign-in (OTP captured from the
  dev email sink), create game, play first move, opponent sees update, finish a scripted game.
