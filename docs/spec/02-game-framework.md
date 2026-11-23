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

  // Playing (pure; replayed, §5)
  setup(ctx: { options: Options; seats: number; rng: RandomSource; res: Resources }): State;
  toAct(state: State): Seat[];                             // seats that may act now ([] when finished)
  seatStatus(state: State): ("playing" | "out")[];         // "out" = eliminated by the rules (or resigned/timed out)
  validate(state: State, seat: Seat, action: Action, res: Resources): Ok | GameError;
  apply(state: State, seat: Seat, action: Action, rng: RandomSource): { state: State; record: PublicRecord };
  onResign(state: State, seat: Seat, rng: RandomSource): { state: State; record: PublicRecord };
  onTimeout(state: State, seat: Seat, rng: RandomSource): { state: State; record: PublicRecord };
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
    perturbHidden(state: State, viewer: Seat, rng: RandomSource): State;
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
   `setup`, `validate` and `preview` receive resources. `apply`, `onResign` and `onTimeout` MUST NOT
   depend on them (`validate` always runs first in the same transition), so replay still works after
   a dictionary changes or is purged.
7. **Resource authorisation is the framework's job.** At create time the framework's
   `ResourceProvider.authorizeForNewGame(kind, id, userId)` checks every entry of
   `resources(options)`: built-in and operator resources must be enabled; an uploaded resource must
   belong to the creator and not be deleted. Failure looks exactly like an unknown id (e.g.
   `400 UNKNOWN_DICTIONARY`). `OptionsContext.resources` lists only what the creator may use.
8. **Module config** is namespaced `GAMES_<TYPE>_*` and parsed with `configSchema` at startup. The
   framework config never contains module-specific variables.

### 2.2 Reserved error codes

Framework codes (05 §Errors) are reserved: `NOT_FOUND`, `GAME_NOT_ACTIVE`, `NOT_YOUR_TURN`,
`STALE_GAME`, `INVALID_ACTION`, `INVALID_OPTIONS`, `INVALID_SEATS`, `NOT_ALLOWED`,
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
  OptionsForm: Component<{ catalog; value: Options; onChange }>;   // catalog = this module's part of /api/catalog
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
`HistoryItem` falls back to the stored `describe` text (§5) for any record it can't render.

The **game shell** (framework UI) supplies everything around the board: header with players,
scores or ranks and whose turn it is, the menu (resign, rules, history, game info), lobby screens,
error toasts, the stale-state refetch, and the realtime refresh. A game module never talks to the
API directly; it only calls `submit` and `preview`. The client may import the module's pure engine
to compute previews locally (e.g. word scores), but it is always non-authoritative.

## 4. Game lifecycle (all games)

```
                  ┌──── creator cancels / lobby expires (14 days from creation) ────▶ cancelled / expired
                  │
 create ──▶ lobby ┼── all seats joined, or creator starts with ≥ min joined ──▶ active ──▶ finished
                  │                                                              │       (result() non-null)
                  └── joined + invited < min and no live join link ──▶ declined ◀─┘
                                                     (a decline before first action leaves < min playing)
```

**Creating.** The creator chooses the game type, options (resolved by `resolveOptions`), the seat
count (within `players(options)`), the **turn timeout** (whole days, 1–30, default
`defaultTurnTimeoutDays(options)`; validated by the framework, never by the module) and the
**seat order** (`join`: the creator first, then others in the order they joined; or `random`). The
framework checks resource authorisation (§2.1 rule 7). The turn timeout and seat order are shown on
every invitation and in the lobby.

**Seats in the lobby.** The creator holds the first seat. Each other seat is filled by one of:

- **An existing user**, picked by email or from past opponents. Whether they're added straight away
  depends on *their* setting **who can add me to games** (`whoCanAddMe`, 06 §6):
  - `anyone`, or `pastOpponents` (the default) when the creator is a past opponent → *auto-joined*
    (`joined`) and notified;
  - otherwise → an **invitation**: the seat is `invited` with their user id; it appears under
    *Invitations* in their game list with an in-app badge but **no push**; they accept or decline.
- **An email invite** for someone without an account. The seat stays `invited` until they sign up
  with that address (06 §6); it then becomes an invitation to that new user under the same rule.
- **A join link.** The creator can create a shareable link for the open seats (06 §6.8). Anyone
  signed in who opens it and taps Join takes an open seat. An **open seat** is one not held by an
  `invited` or `joined` row.

*Past opponents* are users you've finished a game with: both were seated when it reached
`finished`. A player who joined through a link becomes a past opponent of the creator only, never
of the other players (06 §6.9).

The creator can **remove** any seat while in the lobby (`removed`); a removed user can't rejoin
through the current link (06 §6.8). Lobby joins, leaves and removals send realtime invalidations
only, never pushes.

**Start.** The game moves from `lobby` to `active` automatically once every seat is `joined`. The
creator may also press **Start** once at least `min` seats are joined; unfilled seats are dropped.
At start the framework:

1. calls `validateStart(options, joinedCount)` (failure → `409 INVALID_SEATS`, game stays in lobby);
2. deletes every `game_players` row that isn't `joined` (declined, left, removed, unfilled invites),
   so only real players remain;
3. assigns seats `0..n-1` by the seat order (a `random` order is drawn from the recorded rng);
4. calls `setup` with the final seat count, and starts the clocks for `toAct`.

So a 2-player game against a past opponent starts the moment it's created.

**Decline / leave / remove / resign.**

- **In the lobby**: an invited or joined non-creator may decline (or leave, if joined). The seat
  reopens. The lobby ends as `declined` only when joined + invited < `min` and no join link is live;
  otherwise it waits for a join, Start or expiry. The creator leaving means cancelling.
- **After start, before your first action**: declining ends the game as `declined` (no ranking,
  `end_reason = declined`) if fewer than `min` playing seats would remain, whatever moves the
  creator already made. Otherwise it is treated as a resignation.
- **Resign** (any time while active) → `onResign`. The module decides what happens: in a 2-player
  game it usually ends; in an N-player game the player is out and play continues.

**Timeouts.** A seat that has been in `toAct` for the game's turn timeout is overdue. The sweep
(03 §8) handles overdue seats one transition at a time, in seat order, reloading the game and
re-checking `toAct` and the deadline before each; once a timeout ends the game no further ones run.
Reminders go out at 50 % of the timeout and, for timeouts of 3 days or more, 24 h before the
deadline. Timeouts never apply in the lobby, which has its own expiry: 14 days from creation, not
extended by joins.

**Player states** (`game_players.state`): in the lobby, `invited` · `joined` · `declined` · `left` ·
`removed`; while active or finished, `playing` · `out`. `out_reason` is `resigned` or `timed_out`
when the framework caused it, otherwise `eliminated`. After every transition the framework reads
`seatStatus(state)` and stores newly-out seats in the same transition, and stores rank/score from
`result()` when the game finishes.

**Ranking** uses standard competition ranking: tied seats share a rank and the next rank skips
(1, 2, 2, 4).

**Every transition** (join, accept, remove, start, action, resign, timeout, decline, cancel, expiry,
invite claim) goes through the `write_token` optimistic-concurrency write (03 §5.2) and bumps the
game `version`. Transitions the server starts itself (join, claim, sweep, account deletion) retry up
to 3 times on a version conflict.

## 5. State, history and replay

- The server stores the module's full `State` as JSON (secret, 🔒) in the game row, plus an action
  log of **module transitions only**: kinds `action` (→ `apply`), `resign` (→ `onResign`),
  `timeout` (→ `onTimeout`) and `decline` after start (→ `onResign`). Each entry holds the seat,
  the action (🔒), the `PublicRecord`, the record's `describe` text, and the recorded random draws
  (🔒). Lobby events change `game_players` and `games.status` but aren't logged; `action_count`
  counts log rows only.
- **Replay**: `setup` (with `setup_rng`, which also holds the seat-order draw) followed by
  dispatching every log entry by kind, with its recorded draws, MUST reproduce the stored state
  exactly. The test kit checks this on random games, and it doubles as a corruption and audit tool.
- `describe` returns `Text`: strings plus `{ seat }` placeholders. It's stored with each log entry
  and rendered with current display names ("You" for the viewer, "Deleted player" after account
  deletion), so history and notifications never need module code to display.
- When a game finishes, the framework stores `final_views`: for each seat its final `view` and
  `summary`, plus a public `view(state, null)` and `summary(state, null)`. A player only ever
  receives their own seat's entry. Finished games can then still be displayed after the server-side
  engine version is retired (§7).

## 6. Generic test kit (`packages/sdk/testkit`)

Every game module MUST pass the kit, which runs thousands of random games per module and option
set and seat count, with seeded randomness:

1. **Schema conformance**: every option, view, record, preview and catalog matches its schema;
   every error code is in `errorCodes` and none is reserved (§2.2).
2. **Replay**: as in §5.
3. **Secrecy (perturbation)**: at random points in a game, for each seat `v`, with
   `s' = perturbHidden(s, v)` (which randomises everything `v` can't see — other hands, deck
   order, secret phase actions — while keeping the state consistent):
   - `view`, `summary`, `toAct`, `seatStatus` and `result() === null` are identical for `s` and `s'`;
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
into a view, one into an error detail, one into a record; one is nondeterministic; one never
terminates; one leaves `toAct` non-empty after the end): the kit MUST fail each one.

The framework, not the kit, enforces that only seats in `toAct` may act (05 `/actions`).

Module-specific tests (rules tables, scoring edge cases) are in addition to the kit.

## 7. Versioning and registration

- Each module registers in `packages/games-registry` (server side) and `apps/web` (client side,
  lazy imports). Operators choose which games are offered for new games with `ENABLED_GAMES`.
- Each game row stores `game_type` and `game_version`. Any change to a module's rules or state
  shape releases a new `version`. The old version's engine code stays registered on the server
  while any non-finished game uses it, and new games always use the latest version. Finished games
  need no engine code: they display from `final_views` and stored `describe` text.
- Data that varies within a version (e.g. word-game rulesets, dictionaries) are **options** with
  their own versioning, as defined by the module.

## 8. Player counts and the N-player shell

The framework UI handles 2–8 players from day one:

- The lobby shows all seats and their states, the turn timeout and the seat order.
- The game header shows avatars (initials) in seat order, who is out, each seat's deadline when it
  is to act, and scores or ranks as the module's `summary` provides.
- The finished screen shows the ranking with ties.
- Notifications are sent to seats whose clock started ("your turn"), and to everyone when the game
  ends.

## 9. Out of scope (framework v1)

Spectators, chat, real-time (timed) play, AI opponents, tournaments, cross-game stats, accounts for
children without email (Q20, roadmap M7). The contract above shouldn't block any of them.
