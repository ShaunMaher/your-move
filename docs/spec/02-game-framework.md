# 02 — Game framework

The product is a **platform for asynchronous, turn-based multiplayer games with friends**. Each game
is a self-contained *game module* that plugs into a shared framework. The framework provides
accounts, invitations, lobbies, turn enforcement, timeouts, storage, concurrency, secrecy,
realtime updates and notifications. The game module provides rules and UI.

Shipped game modules:

| Id | Spec | Players | Status |
|---|---|---|---|
| `words` | [games/words.md](games/words.md) | 2 (rulesets may allow up to 4 later) | MVP |
| `paths` | [games/paths.md](games/paths.md) | 2–8 | after MVP (roadmap M5) |

Candidate future modules and the framework features each one exercises are listed in 10 §Later.

Game modules use neutral names and original art. They may share *mechanics* with existing games,
but never their names, characters, artwork or look (CLAUDE.md hard rule).

## 1. Responsibilities

| Framework (game-agnostic) | Game module |
|---|---|
| Accounts, sessions, display names | Options schema, option resolution (variants, e.g. ruleset + dictionary) and player-count limits |
| Creating games, invitations (email, past opponents, join links), lobby, seats, seat order | Setup: initial state from options + seat count + randomness |
| Whose turn it is, and rejecting out-of-turn actions | Action schema, validation, applying actions |
| Optimistic-concurrency transitions (03 §5.2) | Determining who acts next, eliminations, game end, ranking |
| Recording randomness for replay | Per-viewer views (hiding secret information) |
| Turn timeout setting and clocks; resign, decline, leave, remove | Effects of resign and timeout on the game state |
| Storage of state, action log, final views and summaries | Public history records, history/notification text, list summary |
| Realtime invalidation, push, email nudges | Optional preview (e.g. "this play scores 24") |
| Authorising and loading resources a module needs (e.g. dictionaries) | Declaring which resources it needs; module catalog data |
| Game shell UI: list, lobby, menus, history drawer, timers | Game board UI, options form, rules sheet |

## 2. Game module contract (server / engine side)

Every engine lives in `games/<id>/engine` as **pure TypeScript**: no I/O, no clock, no direct
randomness, and no imports from the framework or any runtime. It exports a `GameDefinition` typed by
`packages/sdk`:

```ts
type Seat = number;                                        // 0..seats-1, fixed at start (§4)
type GameError = { code: string; detail?: unknown };       // module codes, never a reserved code (§2.2)
type Text = (string | { seat: Seat })[];                   // names are inserted at render time (§5)
type ModuleConfig = unknown;                               // parsed from this module's GAMES_<TYPE>_* keys only (§2.1 rule 8)
type ResourceRequest = { kind: "dictionary"; id: string; version?: number };  // framework resource kinds (§2.1 rule 7)
type ListSummary = { headline: Text; scores?: number[] };  // one line in the game list
type FrameworkError = { code: string; message: string; detail?: unknown };   // 05 §Errors
type SubmitResult = { ok: true; game: GameEnvelope; view: unknown } | { ok: false; error: GameError | FrameworkError };
type ResourceMeta = {                                      // metadata only, never contents (08 T22)
  kind: "dictionary"; id: string; version: number; name: string;
  language: string; alphabet: string[];                    // what compatibility checks need (words §9.3)
  distribution: "public" | "serverOnly"; source: "builtin" | "operator" | "upload";
};
type ResourceCatalog = ResourceMeta[];
type Resources = {                                         // loaded for one game, synchronous (§2.1 rule 6)
  dictionary?: { id: string; version: number; has(word: string): boolean };
};
type ExitReason = "resign" | "decline";                    // why a seat leaves through onResign/onTimeout (§4)

interface GameDefinition<Options, State, Action, View, PublicRecord, PreviewResult = never> {
  type: string;                 // "words"
  version: number;              // bump on any rule or state-shape change (§7)

  // Schemas (all checked by the test kit, §6)
  configSchema: Schema<ModuleConfig>;     // the module's namespaced env config, e.g. GAMES_WORDS_* (09 §1)
  optionsSchema: Schema<Options>;
  actionSchema: Schema<Action>;
  viewSchema: Schema<View>;
  recordSchema: Schema<PublicRecord>;
  previewSchema?: Schema<PreviewResult>;
  catalogSchema: Schema<unknown>;
  errorCodes: readonly string[];          // every code validate/preview/resolveOptions/validateStart can return

  // Creating a game (runs in the framework at create time, not replayed)
  resolveOptions(input: unknown, ctx: OptionsContext): Options | GameError; // defaults, latest versions, enabled lists, compatibility
  catalog(ctx: OptionsContext): unknown;                   // module part of GET /api/catalog (e.g. rulesets, compatibility, defaults)
  players(options: Options): { min: number; max: number };
  validateStart(options: Options, seats: number): Ok | GameError;  // e.g. enough tiles for this many players
  defaultTurnTimeoutDays(options: Options): number;        // framework owns the timeout (§4); this is only the default
  resources(options: Options): ResourceRequest[];          // e.g. [{ kind: "dictionary", id: "enable" }]
  checkConfig(config: ModuleConfig, catalog: ResourceCatalog): Ok | GameError; // startup (§2.1 rule 8), e.g. default dictionary enabled and compatible

  // Playing (pure; replayed, §5)
  setup(ctx: { options: Options; seats: number; rng: RandomSource }): State;   // no resources (rule 6)
  toAct(state: State): Seat[];                             // seats that may act now ([] when finished)
  seatStatus(state: State): ("playing" | "out")[];         // "out" = eliminated by the rules (or resigned/timed out)
  validate(state: State, seat: Seat, action: Action, res: Resources): Ok | GameError;
  apply(state: State, seat: Seat, action: Action, rng: RandomSource): { state: State; record: PublicRecord };
  onResign(state: State, seat: Seat, rng: RandomSource, reason: ExitReason): { state: State; record: PublicRecord };
  onTimeout(state: State, seat: Seat, rng: RandomSource): { state: State; record: PublicRecord };   // only for seats that have acted (§4)
  result(state: State): null | {                           // null while in progress
    ranking: { seat: Seat; rank: number; score?: number }[]; // standard competition ranking (§4)
    endReason: string;                                       // module-defined, e.g. "out", "last-standing"
  };

  // Presenting
  view(state: State, viewer: Seat | null): View;           // the ONLY way state reaches a client; null = public view
  preview?(state: State, seat: Seat, action: Action, res: Resources): PreviewResult | GameError;
  describe(record: PublicRecord): Text;                    // history + notification text, e.g. [{seat:1}, " played QUIZ for 64"]
  summary(state: State, viewer: Seat | null): ListSummary; // { headline: Text, scores? } for the game list

  test: {                                                  // used by the generic test kit (§6)
    randomAction(state: State, seat: Seat, rng: RandomSource, res: Resources): Action;    // MUST validate
    randomAnyAction(state: State, seat: Seat, rng: RandomSource): Action;  // schema-valid, often illegal, biased to near-legal
    perturbHidden(state: State, viewer: Seat | null, rng: RandomSource): State; // null = everything hidden from the public view
    hiddenInformation: boolean;                            // true if the game has any hidden information (hands, deck order, secret actions)
    maxActions(options: Options, seats: number): number;  // termination bound
    worstCase(options: Options, seats: number, rng: RandomSource): { state: State; seat: Seat; action: Action }[]; // CPU budget
    publicRandomness?: boolean;                            // true if records legitimately show random draws (e.g. dice)
  };
}

type OptionsContext = {
  config: ModuleConfig;          // parsed configSchema values
  resources: ResourceCatalog;    // metadata of resources this creator may use (already filtered by the framework, §2.1)
};
```

### 2.1 Contract rules

Enforced by the generic test kit (§6) where possible:

1. **Determinism**: given the same state, action and random values, `apply`, `onResign` and
   `onTimeout` return the same result.
2. **Randomness** comes only from the `rng` argument. The framework wraps the WebCrypto source so
   every value drawn is recorded. This makes every game replayable (§5).
3. **Errors** are values (`GameError`), never exceptions, and use only codes in `errorCodes`.
   Exceptions mean a bug and become a `500` with no detail (05 §Errors).
4. **Secrecy**: while the game is in progress, `view`, `summary`, `toAct`, `seatStatus`, whether
   `result()` is null, and the results of `validate` and `preview` (including error `detail`) for a
   seat MUST NOT depend on information hidden from that seat. After `result()` is non-null, `view`
   may reveal anything the module chooses (e.g. final racks).
5. **Public records** contain only information visible to every seat. They appear in history and
   notifications, and `describe` builds text from the record alone.
6. **Resources** are loaded by the framework before calling the module and passed in as synchronous
   lookup objects, so the module stays pure. Example: a dictionary's `has(word): boolean`. Only
   `validate` and `preview` receive resources. `setup`, `apply`, `onResign` and `onTimeout` MUST NOT
   depend on them (`validate` always runs first in the same transition), so replay works after a
   dictionary changes or is purged. The kit replays with an **empty** resource provider to prove it.
7. **Resources are a framework concept.** The framework defines the resource kinds (v1: only
   `dictionary`), their storage, their config (`DICTIONARIES_ENABLED`, `DICTIONARY_UPLOADS`,
   `DICTIONARIES_EXTRA`, 09 §1) and their authorisation. At create time
   `ResourceProvider.authorizeForNewGame(kind, id, userId)` checks every entry of
   `resources(options)`: built-in and operator resources must be enabled; an uploaded resource must
   belong to the creator and not be deleted. `OptionsContext.resources` already lists only what the
   creator may use, so `resolveOptions` normally rejects anything else itself; if authorisation
   still fails (e.g. the upload was deleted in between), the framework answers exactly as
   `resolveOptions` would for an unknown id: `400 INVALID_OPTIONS` with `detail: { code }`, where
   `code` is the kind's `unknownCode` (`UNKNOWN_DICTIONARY` for dictionaries).
8. **Module config** is namespaced `GAMES_<TYPE>_*`. Each module receives **only its own keys**,
   with the prefix stripped, parsed by its strict `configSchema` at startup — never the full
   environment (which holds `APP_SECRET`), because `catalog()` output reaches clients. Module type
   ids match `^[a-z][a-z0-9]*$` so prefixes can't overlap. Startup errors name the failing key but
   never echo config values. The framework config never contains module-specific variables, and
   modules never read framework resource config. Cross-checks between the two (e.g. the words
   default dictionary must be enabled and compatible) go through `checkConfig(config, catalog)`,
   which the framework calls at startup with the metadata of every enabled built-in and operator
   resource; an error stops startup and names the module key.
9. **Exit reasons**: `onResign` receives `reason`. `"decline"` is used for a seat leaving before
   its first action (§4): the module removes the seat exactly as for a resignation, but its record
   and `describe` text say the player *declined* (e.g. [{seat:2}, " declined the game"]), never
   "resigned", and nothing in the record presents it as a loss.

### 2.2 Reserved error codes

Framework codes (05 §Errors) are reserved: `NOT_FOUND`, `GAME_NOT_ACTIVE`, `NOT_YOUR_TURN`,
`STALE_GAME`, `INVALID_ACTION`, `INVALID_OPTIONS`, `INVALID_SEAT_COUNT`, `INVALID_SEATS`, `NOT_ALLOWED`,
`RATE_LIMITED`, and every other code in the 05 table. The kit rejects a module whose `errorCodes`
contains one.

### 2.3 Turn model

`toAct` returns a *set* of seats. Usually it's one seat (normal turns). Several seats means a phase
where each of them must act, in any order, e.g. agreeing on a Go score, passing cards, or secret
setup:

- Each seat's action is still its own transition, serialised by the version check. So "at the same
  time" really means "in any order".
- A seat leaves `toAct` once its action in the phase is accepted, unless the module wants it to act
  again (e.g. an extra turn). If an action must stay secret until everyone has acted, the module
  keeps it in state and hides it in `view` until the phase ends. The secrecy test covers this.
- **Clocks**: after every transition the framework recomputes `toAct`. A seat's clock
  (`to_act_since`) starts when the seat enters `toAct` and restarts whenever that seat's action is
  accepted and it stays in `toAct`. Seats that stay in `toAct` without acting keep their clock.
  Every transition that (re)starts a seat's clock also resets its `timeout_reminders_sent` to 0.
- "Your turn" notifications go to every seat whose clock (re)started in the transition.
- Empty-handed or otherwise unable seats are never put in `toAct`: the module skips them itself and
  notes the skip in the record (kit check: every seat in `toAct` has a validating action).

## 3. Client module contract

Each game has a client package `games/<id>/client`, which the web app lazy-loads (code-split) the
first time a game of that type is opened:

```ts
interface GameClientModule<Options, Action, View, PreviewResult> {
  type: string;
  versions: number[];                 // every server module version whose views/records it can render
  name: string;                       // neutral display name, e.g. "Words"
  icon: Component;                    // original artwork (SVG)
  OptionsForm: Component<{ catalog; value: unknown; onChange(input: unknown) }>; // edits the unresolved input; catalog = this module's part of /api/catalog
  Board: Component<{
    game: GameEnvelope; view: View;   // view shape per game.gameVersion
    submit(action: Action): Promise<SubmitResult>;
    preview(action: Action): Promise<PreviewResult | GameError>;   // local when possible, else server
  }>;
  RulesSheet: Component<{ options: Options; gameVersion: number }>;
  HistoryItem: Component<{ record: unknown; gameVersion: number; names: string[] }>;
}
```

The client keeps rendering support for **every version ever released** (per-version view schemas,
or a pure `upgradeView(version, view)` to the current shape), so finished games always display.
The shell's history drawer reads `GET /api/games/:id/history` (05), which returns each logged
transition's public `record` and stored `describe` text; `HistoryItem` renders the record, falling
back to the `describe` text for any record it can't render. Module views never carry history.

The **game shell** (framework UI) supplies everything around the board: header with players,
scores or ranks and whose turn it is, the menu (resign, rules, history, game info), lobby screens,
error toasts, the stale-state refetch, and the realtime refresh. A game module never talks to the
API directly; it only calls `submit` and `preview`. The client may import the module's pure engine
to compute previews locally (e.g. word scores), but it is always non-authoritative.

## 4. Game lifecycle (all games)

```
                  ┌──── creator cancels / lobby expires (14 days from creation) ────▶ cancelled / expired
                  │
 create ──▶ lobby ┼── all seats joined (auto-start, §4 Start), or creator presses Start ──▶ active ──▶ finished
                  │                                                                        │   (result() non-null)
                  └── a decline/leave leaves joined + invited < min ────────▶ declined ◀───┘
                      and no join link is live                     (a decline or timeout before a seat's
                                                                    first action leaves < min playing)
```

**Creating.** The creator chooses the game type, options (resolved by `resolveOptions`), the seat
count (within `players(options)`, else `400 INVALID_SEAT_COUNT`), the **turn timeout** (whole days,
1–30, default `defaultTurnTimeoutDays(options)`; validated by the framework, never by the module)
and the **seat order** (`join`: the creator first, then others in the order they joined; or
`random`). The framework checks resource authorisation (§2.1 rule 7) and calls
`validateStart(options, seats)` for the chosen seat count; failure → `409 INVALID_SEATS` and nothing
is stored. The turn timeout and seat order are shown on every invitation and in the lobby.

**Seats in the lobby.** The creator holds the first seat. Each other seat is filled by one of:

- **A past opponent picked from the list** (by user id). Whether they're added straight away
  depends on *their* setting **who can add me to games** (`whoCanAddMe`, 06 §6.2): with
  `pastOpponents` (the default) they're *auto-joined* (`joined`) and notified; with `nobody` they get
  an invitation.
- **An email address.** The response never reveals whether the address has an account (06 §6.1,
  Q3). An onboarded user with that address gets an **invitation**: the seat is `invited` with their
  user id; it appears under *Invitations* in their game list with an in-app badge and only a generic
  push that names nobody (06 §6.2);
  they accept or decline. Anyone else (no account, or an account that hasn't finished onboarding)
  gets an **email-invite seat**, claimed when they complete onboarding with that address (06 §6.4),
  after which it is an invitation like any other. Typing a past opponent's email also gives an
  invitation, never an auto-join.
- **A join link.** The creator can create a shareable link for the open seats (06 §6.8). Anyone
  signed in and onboarded who opens it and taps Join takes an open seat. An **open seat** is one not
  held by an `invited` or `joined` row. A user who already holds an invitation in the game and joins
  through the link is treated as accepting it.

A row that has never been `joined` (`joined_at` NULL) never shows a display name or user id to
anyone, in any state (`invited`, `declined`, `removed`, `dropped`, 05 §Common types): the creator
sees the address they typed (or "Invited"/"Declined"/"Removed" for a picked past opponent), other
members see only the state (06 §6.1).

*Past opponents* are pairs of users who both took at least one action (`acted_once`) in a game that
reached `finished`. A player who joined through a link is never recorded automatically: at the end
the creator is asked "Add <name> to your players?" and only a yes records the pair (creator ↔ that
player, never the other players; 06 §6.9). A pair with a block in either direction is never
recorded, at the finish or through that question (06 §6.10).

The creator can **remove** any other seat while in the lobby (`removed`); a removed user can't rejoin
through the link that was live when they were removed (06 §6.8).

**Lobby notifications.** The only pushes a lobby causes go to the person being added: an auto-join
push naming the creator ("<creator> added you to a game") and the generic invitation push that names
nobody (06 §6.2). Joins by others, accepts, declines, leaves, removals and lobby endings
(`cancelled`, `expired`, `declined` from the lobby) send realtime invalidations to members only,
never pushes or emails.

**Start.** The creator may press **Start** once at least `min` seats are joined; unfilled seats are
dropped. The game also starts **automatically** once every seat is `joined`, except while a join
link is live or any `joined` row has `joined_via = join_link`: then only the creator's Start begins it, so
the creator always sees who joined through a link before play starts. At start the framework, in
the start transition:

1. re-checks blocks between every pair of joined users: if a pair has a block, the member of the
   pair who joined later is moved to `removed` (realtime only); if fewer than `min` remain the start
   fails with `409 NOT_ENOUGH_PLAYERS` (or, for an automatic start, simply doesn't happen); a pair
   with a block never becomes past opponents later either;
2. calls `validateStart(options, joinedCount)`. On failure, Start returns `409 INVALID_SEATS`; an
   automatic start simply doesn't happen, the triggering transition (accept or join) still
   succeeds, and the game waits in the lobby for the creator;
3. marks every row that isn't `joined` as out of the game: `declined`, `left` and `removed` rows
   keep their state, unfilled `invited` rows become `dropped`, all with `seat` NULL and
   `invite_email` cleared. These rows grant no access (04 §Membership); they're kept only so a
   player can still block someone they shared a lobby with;
4. assigns seats `0..n-1` to joined rows by the seat order (a `random` order is drawn from the
   recorded rng), sets them `playing`;
5. calls `setup` with the final seat count, and starts the clocks for `toAct`.

So a 2-player game against a past opponent (default setting) starts the moment it's created.

**Decline / leave / remove (lobby).** An invited or joined non-creator may decline (or leave, if
joined). The seat reopens. Only decline and leave check whether the lobby can still fill: it ends
as `declined` when `joined + invited < min` (every `invited` row counts, whatever its delivery, 04)
and no join link is live; otherwise it waits for a join, Start or expiry. A **remove** never ends
the lobby — the creator chose it, and can still share a link, add players or cancel. Revoking a
link or its expiry never ends a lobby by itself either. The creator leaving means cancelling.

**Before a seat's first action (active game).** Any `playing` seat that hasn't acted yet
(`acted_once = 0`), the creator's included, may **decline**; the same rule applies if it **times
out** before acting:

- If fewer than `min` playing seats would remain, the game ends as **`declined`**. This is a
  framework-only transition: the module isn't called, nothing is logged, the state is frozen as it
  is, the declining (or timed-out) seat's row is set `out` with `out_reason = declined`, no seat
  gets a rank (`rank` NULL for everyone), `end_reason = declined`, and `final_views` are written
  from the frozen state. Moves other players already made don't change this.
- Otherwise the seat is out with `out_reason = declined`: the transition is logged as `decline`
  (for a timeout too) and dispatched to `onResign(…, "decline")`, so the record says "declined"
  (§2.1 rule 9), and play continues. Seats out as `declined` are excluded from the final ranking
  (below).

Either way a player who never acted takes no loss.

**Resign** (any time while active, after or before acting) → `onResign`. The module decides what
happens: in a 2-player game it usually ends; in an N-player game the player is out and play
continues. A resignation is a loss.

**Timeouts.** A seat that has been in `toAct` for the game's turn timeout is overdue. The sweep
(03 §8) handles overdue seats one transition at a time, in seat order, reloading the game and
re-checking `toAct` and the deadline before each; once a timeout ends the game no further ones run.
An overdue seat that never acted follows the rule above (logged as `decline`); otherwise
`onTimeout` runs and the seat's `out_reason` is `timed_out`. Reminders go out at 50 % of the timeout and, for timeouts of 3 days or
more, 24 h before the deadline; each clock restart resets the reminder count (§2.3). Timeouts never
apply in the lobby, which has its own expiry: 14 days from creation, not extended by joins.

**Player states** (`game_players.state`): in the lobby, `invited` · `joined` · `declined` · `left` ·
`removed`; while active or finished, `playing` · `out` for seated players, and `declined` · `left` ·
`removed` · `dropped` for unseated rows kept from the lobby. `out_reason` is `resigned`,
`timed_out` or `declined` when the framework caused it, otherwise `eliminated`. After every
module transition the framework reads `seatStatus(state)` and stores newly-out seats in the same
transition, and stores rank/score from `result()` when the game finishes. (The framework-only
`declined` ending sets the decliner's row itself; 04 invariant 3 covers `active` games only.)

**Ranking** uses standard competition ranking: tied seats share a rank and the next rank skips
(1, 2, 2, 4). The framework drops seats whose `out_reason` is `declined` from `result().ranking`
(their `rank` stays NULL) and re-ranks the rest by the module's order with the same convention.

**Every transition** (join, accept, remove, leave, start, action, resign, timeout, decline, cancel,
expiry) goes through the `write_token` optimistic-concurrency write (03 §5.2) and bumps the game
`version`. Transitions the server starts itself (join, sweep, account deletion) retry up to 3 times
on a version conflict.

**Invite claims are not game transitions.** Claiming an email-invite seat (06 §6.4) is a
row-level update of that one `game_players` row, guarded by `state = 'invited' AND user_id IS NULL`
and the game being in `lobby`. It doesn't bump the game `version`, sends no realtime event to
other members, and changes nothing the creator or other members can see (the row still shows the
typed address or "Invited"); only the claimant's own game list updates. A concurrent start, remove
or cancel simply makes the guard fail.

## 5. State, history and replay

- The server stores the module's full `State` as JSON (secret, 🔒) in the game row, plus an action
  log of **module transitions only**: kinds `action` (→ `apply`), `resign` (→ `onResign(…,
  "resign")`), `timeout` (→ `onTimeout`) and `decline` — a decline or timeout before a first action
  when the game continues (→ `onResign(…, "decline")`). Each
  entry holds the seat, the action (🔒), the `PublicRecord`, the record's `describe` text, and the
  recorded random draws (🔒). Lobby events and the framework-only `declined` ending (§4) change
  `game_players` and `games.status` but aren't logged; `action_count` counts log rows only.
- **Replay**: `setup` (with `setup_rng`, which also holds the seat-order draw) followed by
  dispatching every log entry by kind, with its recorded draws, MUST reproduce the stored state
  exactly. The test kit checks this on random games, and it doubles as a corruption and audit tool.
- `describe` returns `Text`: strings plus `{ seat }` placeholders. It's stored with each log entry
  and rendered with current display names ("You" for the viewer, "Deleted player" after account
  deletion), so history and notifications never need module code to display. Members read the log
  through `GET /api/games/:id/history` (05), which returns only `seq`, `seat`, `kind`, `record` and
  `describe` — never the action or the draws.
- When a game reaches **any terminal status after start** (`finished`, or `declined` before a first
  action), the framework stores `final_views`: for each seat its final `view` and `summary`, plus a
  public `view(state, null)` and `summary(state, null)`. A player only ever receives their own
  seat's entry. Every non-active, non-lobby game is displayed from them, so it can still be shown
  after the server-side engine version is retired (§7). Games that never started have no state and
  display from the envelope alone.

## 6. Generic test kit (`packages/sdk/testkit`)

Every game module MUST pass the kit, which runs thousands of random games per module and option
set and seat count, with seeded randomness:

1. **Schema conformance**: every option, view, record, preview and catalog matches its schema;
   every error code is in `errorCodes` and none is reserved (§2.2).
2. **Replay**: as in §5, with an empty resource provider (§2.1 rule 6).
3. **Secrecy (perturbation)**: at random points in a game, for each seat `v` **and for the public
   viewer `v = null`**, with `s' = perturbHidden(s, v)` (which randomises everything `v` can't see —
   other hands, deck order, secret phase actions; for `null`, everything hidden from the public
   view — while keeping the state consistent):
   - `view`, `summary`, `toAct`, `seatStatus` and `result() === null` are identical for `s` and `s'`;
   - the perturbation isn't vacuous: for a module with `hiddenInformation: true`, `s'` differs from
     `s` in at least half of the samples taken while `result()` is null;
   - `validate` and `preview` results, including `detail`, are identical for `s` and `s'`, for
     legal actions from `randomAction` **and** for possibly-illegal ones from `randomAnyAction`;
   - the `record` from `apply`/`onResign`/`onTimeout` by any seat is identical for `s` and `s'`
     (whenever the action still validates on `s'`), both with the same recorded draws and, unless
     `publicRandomness` is set, with different draws. This catches drawn tiles leaking into history.
4. **Termination**: random play always reaches `result() !== null` within `maxActions(options, seats)`.
5. **Turn sanity** (module-checkable): `toAct` ⊆ seats that `seatStatus` reports `playing`; every
   seat in `toAct` has an action that validates (`randomAction` result is checked); a seat reported
   `out` never returns to `playing` or `toAct`; `toAct` is empty exactly when `result()` is non-null.
6. **CPU budget**: per-call CPU for `validate` + `apply` (and `preview`) on the `worstCase` inputs
   stays within the budget in 08 T25.

The kit itself is tested against deliberately **broken fixture modules** (one leaks hidden state
into a view, one into an error detail, one into a record, one into the public view; one has a
no-op `perturbHidden`; one reads resources in `setup`; one is nondeterministic; one never
terminates; one leaves `toAct` non-empty after the end): the kit MUST fail each one.

The framework, not the kit, enforces that only seats in `toAct` may act (05 `/actions`).

Module-specific tests (rules tables, scoring edge cases) are in addition to the kit.

## 7. Versioning and registration

- Each module registers in `packages/games-registry` (server side) and `apps/web` (client side,
  lazy imports). Operators choose which games are offered for new games with `ENABLED_GAMES`.
- Each game row stores `game_type` and `game_version`. Any change to a module's rules or state
  shape releases a new `version`. The old version's engine code stays registered on the server
  while any `lobby` or `active` game uses it, and new games always use the latest version. Finished games
  need no engine code: they display from `final_views` and stored `describe` text.
- Data that varies within a version (e.g. word-game rulesets, dictionaries) are **options** with
  their own versioning, as defined by the module.

## 8. Player counts and the N-player shell

The framework UI handles 2–8 players from day one:

- The lobby shows all seats and their states, the turn timeout and the seat order.
- The game header shows avatars (initials) in seat order, who is out, each seat's deadline when it
  is to act, and scores or ranks as the module's `summary` provides.
- The finished screen shows the ranking with ties and the end reason (e.g. "Declined — no result").
- Pushes go to seats whose clock started ("your turn"); to every seated player when a game that
  reached `active` ends; to a user auto-joined by a past opponent ("<creator> added you to a
  game"); and to a user with a new invitation, generically ("You have a new game invitation",
  06 §6.2). Nothing else in the lobby pushes, and lobby endings send no push or email (§4).

## 9. Out of scope (framework v1)

Spectators, chat, real-time (timed) play, AI opponents, tournaments, cross-game stats, accounts for
children without email (Q20, roadmap M7). The contract above shouldn't block any of them.
