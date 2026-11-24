# 02 — Game framework

The product is a **platform for asynchronous, turn-based multiplayer games with friends**. Each game
is a self-contained *game module* that plugs into a shared framework. The framework provides
accounts, invitations, lobbies, turn enforcement, timeouts, storage, concurrency, secrecy,
realtime updates and notifications. The game module provides rules and UI.

Every game module is shipped as a **game package** (§7): an npm package that anyone can write in
their own repository, against the published SDK, and that an operator installs into their own
instance at build time. The first-party games are built exactly the same way, so the contract is
proven by its own authors.

First-party game packages:

| Id | Package | Spec | Players | Status |
|---|---|---|---|---|
| `example` | `@your-move/game-example` | §7.6 (reference module) | 2–4 | M1; public example for game authors, disabled by default |
| `words` | `@your-move/game-words` | [games/words.md](games/words.md) | 2 (rulesets may allow up to 4 later) | MVP |
| `paths` | `@your-move/game-paths` | [games/paths.md](games/paths.md) | 2–8 | after MVP (roadmap M5) |

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
| Installing packages, generating the registry, running the kit and architecture rules at build (§7) | Its manifest, its own tests, passing the kit |
| API tokens, AI accounts and the AI-assistance rule (§9) | Nothing: modules never know whether a move came from a person or an agent |

## 2. Game module contract (server / engine side)

Every engine is the `/engine` entry point of a game package (§7.1), written in **pure TypeScript**:
no I/O, no clock, no direct randomness, and no imports from the framework, any runtime or the DOM
(enforced by the architecture rules the test kit ships, §7.5). It exports one `GameDefinition`
per supported rules version, typed by `@your-move/sdk`:

```ts
// All of these types are exported by @your-move/sdk (§7.4). Schema<T> is a Zod schema: the SDK
// declares zod (one pinned major) as a peer dependency and re-exports it as
// "@your-move/sdk/schema", so engines build schemas without importing anything else.
type Schema<T> = z.ZodType<T>;
type Seat = number;                                        // 0..seats-1, fixed at start (§4)
type GameError = { code: string; detail?: unknown };       // module codes, never a reserved code (§2.2)
type Text = (string | { seat: Seat })[];                   // names are inserted at render time (§5)
type ModuleConfig = unknown;                               // parsed from this module's GAMES_<TYPE>_* keys only (§2.1 rule 8)
type ResourceRequest = { kind: "dictionary"; id: string; version?: number };  // framework resource kinds (§2.1 rule 7)
type ListSummary = { headline: Text; scores?: number[] };  // one line in the game list
type FrameworkError = { code: string; message: string; detail?: unknown };   // 05 §Errors
type GameEnvelope = /* 05 §Common types; a Zod schema defined in the SDK and registered by the server, so the generated api-client type is structurally identical (§7.4) */;
type SubmitResult = { ok: true; game: GameEnvelope; view: unknown } | { ok: false; error: GameError | FrameworkError };
type ResourceMeta = {                                      // metadata only, never contents (08 T22)
  kind: "dictionary"; id: string; version: number; name: string;
  language: string; alphabet: string[];                    // what compatibility checks need (words §9.3)
  distribution: "public" | "serverOnly"; source: "builtin" | "operator" | "upload";
  downloadUrl?: string;                                    // set by the framework for public distribution only (words §9.4)
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
  catalog(ctx: OptionsContext): unknown;                   // module part of GET /api/v1/catalog (e.g. rulesets, compatibility, defaults)
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
    hiddenFromEveryone?: boolean;                          // true if no seat ever sees the hidden information (e.g. deck order only), §6.3
    optionInputs(ctx: OptionsContext): unknown[];          // the option inputs the kit plays (§6); required, non-empty
    context?(): OptionsContext;                            // what resolveOptions, catalog and checkConfig see in the kit; default: configSchema.parse({}), no resources
    resources?(options: Options): Resources;               // what validate and preview get in the kit's games; default: none
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
   Exceptions mean a bug and become a `500` with no detail (05 §Errors); the kit reports an
   exception from any module function, a transition's included, as a schema failure (§6.1). A
   `GameError` is recognised by its shape (an object whose only keys are a string `code` and an
   optional `detail`), so resolved options and preview results never have that shape.
4. **Secrecy**: while the game is in progress, `view`, `summary`, `toAct`, `seatStatus`, whether
   `result()` is null, and the results of `validate` and `preview` (including error `detail`) for a
   seat MUST NOT depend on information hidden from that seat. After `result()` is non-null, `view`
   may reveal anything the module chooses (e.g. final racks).
5. **Public records** contain only information visible to every seat. They appear in history and
   notifications, and `describe` builds text from the record alone. Because the kit compares the
   record of a transition on a state and on its perturbation (§6.3), a record never depends on
   information hidden before the transition, even what the transition reveals (e.g. the cards
   shown when a secret phase ends, or who lost a life because of them): such outcomes reach
   players through `view`.
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

Each game package's `/client` entry point exports a `GameClientModule`, which the web app
lazy-loads (code-split) the first time a game of that type is opened. Client modules may import
only `@your-move/sdk` (including its client helpers), React, and their own package's `/engine`
(§7.5):

```ts
interface GameClientModule<Options, Action, View, PreviewResult> {
  type: string;
  versions: number[];                 // every server module version whose views/records it can render
  // name, icon and rules text live in the manifest (§7.2), so the new-game picker never loads a client chunk
  OptionsForm: Component<{ catalog; value: unknown; onChange(input: unknown) }>; // edits the unresolved input; catalog = this module's part of /api/v1/catalog
  Board: Component<{
    game: GameEnvelope; view: View;   // view shape per game.gameVersion
    submit(action: Action): Promise<SubmitResult>;
    preview(action: Action): Promise<PreviewResult | GameError>;   // local when possible, else server
  }>;
  RulesSheet: Component<{ options: Options; gameVersion: number }>;   // may render the manifest's rules markdown (§7.2)
  HistoryItem: Component<{ record: unknown; describe: Text; gameVersion: number; names: string[] }>; // describe: the stored fallback text
}
```

The client keeps rendering support for **every version ever released** (per-version view schemas,
or a pure `upgradeView(version, view)` to the current shape), so finished games always display.
The shell's history drawer reads `GET /api/v1/games/:id/history` (05), which returns each logged
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
                  │     (an operator may also cancel a lobby)
 create ──▶ lobby ┼── all seats joined (auto-start, §4 Start), or creator presses Start ──▶ active ──▶ finished
                  │                                                                        │   (result() non-null)
                  └── a decline/leave leaves joined + invited < min ────────▶ declined ◀───┤
                      and no join link is live                     (a decline or timeout before a seat's
                                                                    first action leaves < min playing)
                                                                                           │
                                                   operator cancel (§4) ──▶ cancelled ◀────┘
```

**Creating.** The creator chooses the game type, options (resolved by `resolveOptions`), the seat
count (within `players(options)`, else `400 INVALID_SEAT_COUNT`), the **turn timeout** (whole days,
1–30, default `defaultTurnTimeoutDays(options)`; validated by the framework, never by the module)
the **seat order** (`join`: the creator first, then others in the order they joined; or
`random`) and **AI assistance** (`aiAssistance: "off" | "allowed"`, §9.3). The default is `off`
whenever the game has **any open seat** (a seat not filled by the creator or one of the creator's
own AI accounts at creation: invitees, email seats and link seats are all open) or two or more
human seats; otherwise (the creator alone with their own AI accounts) it is `allowed`. It is fixed
at creation and never changes. The framework checks resource authorisation (§2.1 rule 7) and calls
`validateStart(options, seats)` for the chosen seat count; failure → `409 INVALID_SEATS` and nothing
is stored. The turn timeout, seat order and AI-assistance setting are shown on every invitation
and in the lobby, and the AI setting also in the game header.

**Seats in the lobby.** The creator holds the first seat. Each other seat is filled by one of:

- **One of the creator's own AI accounts** (§9.2), picked at creation. It is auto-joined, is
  labelled "<owner>'s AI" everywhere, and is the only way an AI account is ever seated. If the game
  type declares hidden information (manifest `hiddenInformation`, §7.2), an owner's AI seats are
  allowed only when no other human can join: every non-creator seat is one of the creator's own AI
  accounts (`400 AI_SEATS_NOT_ALLOWED` otherwise), because the owner can read their agent's hand
  through its token (08 T31).
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
anyone but the creator, and to the creator only for a past opponent they picked by `userId`, whose
name they already know (05 §Common types). While such a row is `invited`, the creator sees the
address they typed or the picked past opponent's name; once it is `declined`, `removed` or `dropped`
the creator sees only the state ("Declined", "Removed"), for every kind of row alike, because the
typed address has been cleared (06 §6.5). Other members only ever see the state (06 §6.1).

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
the creator always sees who joined through a link before play starts. A game with an AI seat (other
than one where every other seat is the creator's own AI) or with `aiAssistance = allowed` and
another human never auto-starts, and a past opponent picked for it gets an **invitation** instead
of an auto-join, whatever their `whoCanAddMe`: every human sees the AI seats and the AI setting and
accepts knowingly (08 T31). At start the framework, in
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

So a 2-player game against a past opponent (default setting, no AI) starts the moment it's
created, and so does a game of the creator against their own AI accounts.

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

**Operator cancel.** An admin (05 §Admin API) may cancel a `lobby` or `active` game, e.g. after
abuse or an orphaned game type (§7.3). It is a framework-only transition: the module isn't called,
state is frozen, ranks stay NULL, `games.status = cancelled`, `end_reason = operator_cancelled`.
For an `active` game, `playing` rows become `out` with `out_reason = cancelled`, `final_views` are
written as for any terminal status after start (§5) — unless the game type or rules version has no
engine any more (§7.3), in which case `final_views` stay NULL and the game displays from the
envelope only — and the game stays in members' lists for 90 days like a finished game. A lobby
cancel behaves like the creator's cancel. Seated members of an active game get one "cancelled by
the operator" notification; the admin's `reason` is never shown to players (it stays in
`admin_audit`, 04).

**Every transition** (join, accept, remove, leave, start, action, resign, timeout, decline, cancel,
operator cancel, expiry) goes through the `write_token` optimistic-concurrency write (03 §5.2) and bumps the game
`version`. Transitions the server starts itself (join, sweep, account deletion) retry up to 3 times
on a version conflict.

**Invite claims are not game transitions.** Claiming an email-invite seat (06 §6.4) is a
row-level update of that one `game_players` row, guarded by `state = 'invited' AND user_id IS NULL
AND delivery <> 'inert'`, by **no other row in this game holding the claimant's user id**, by the
game being in `lobby`, and by `games.version` still equalling the version loaded for the block and
cap checks (checked, **not** bumped; on a mismatch the claim reloads and retries, up to 3 times). An
`inert` row is never claimed and its `delivery` is never recomputed. The inbound-cap count (06 §6.7)
is taken atomically in the same write. A claim doesn't bump the game `version`, sends no realtime
event to other members, and changes nothing the creator or other members can see (the row still
shows the typed address or "Invited"); only the claimant's own game list updates. A concurrent
start, remove, join, accept or cancel simply makes the guard fail.

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
  through `GET /api/v1/games/:id/history` (05), which returns only `seq`, `seat`, `kind`, `record` and
  `describe` — never the action or the draws.
- When a game reaches **any terminal status after start** (`finished`; `declined` before a first
  action; `cancelled` by an operator after start), the framework stores `final_views` (except for
  an orphaned game whose engine is gone, §7.3): for each seat its final `view` and `summary`, plus a
  public `view(state, null)` and `summary(state, null)`. A player only ever receives their own
  seat's entry. Every non-active, non-lobby game is displayed from them, so it can still be shown
  after the server-side engine version is retired (§7). Games that never started have no state and
  display from the envelope alone.

## 6. Generic test kit (`@your-move/testkit`)

Every game module MUST pass the kit, which plays many random games per rules version, with seeded
randomness (counts below). It plays every option input the module's **`test.optionInputs(ctx)`**
lists, each with every seat count that `players(options)` allows and `validateStart` accepts. The
hook is **required and must return at least one input**, so a module can't pass by leaving it out
and being played on its defaults. Covering the option space is the author's job, which the kit
can't check (`[{}]` is accepted): a module with options lists the defaults (`{}`) and enough other
inputs to reach every rule an option changes (each ruleset, each variant, the corners of each
range). The
optional `test.context()` gives what `resolveOptions`, `catalog` and `checkConfig` see (default:
`configSchema` parsed from `{}`, no resources) and `test.resources(options)` what `validate` and
`preview` get in those games (default: none; replay always gets none, rule 6). `pnpm games:verify`
plays exactly these hooks, so a game that needs a dictionary supplies one through them.

1. **Schema conformance**: every option, view, record, preview and catalog matches its schema;
   every error code is in `errorCodes` and none is reserved (§2.2). An exception from any module
   function, a transition's included, fails here (§2.1 rule 3).
2. **Replay**: as in §5, with an empty resource provider (§2.1 rule 6).
3. **Secrecy (perturbation)**: at sampled points of every game, for each seat `v` **and for the
   public viewer `v = null`**, with `s' = perturbHidden(s, v)` (which randomises everything `v`
   can't see — other hands, deck order, secret phase actions; for `null`, everything hidden from
   the public view — while keeping the state consistent):
   - `view`, `summary`, `toAct`, `seatStatus` and `result() === null` are identical for `s` and
     `s'`. Outputs are compared as the JSON the framework serves, **object key order included**
     (it survives JSON and Zod, so a key order that follows hidden state is a leak);
   - the perturbation isn't vacuous: for a module with `hiddenInformation: true`, at least half of
     the samples taken while `result()` is null must change **some other viewer's view** (seat
     `w ≠ v`, or the public view), so reordering a deck while hands are hidden doesn't count. Only
     a module that declares **`test.hiddenFromEveryone: true`** — no seat ever sees its hidden
     information, e.g. only the deck order is hidden — is counted by whether `s'` differs from `s`
     instead (it requires `hiddenInformation: true`);
   - `validate` and `preview` results, including `detail`, are identical for `s` and `s'`, for
     legal actions from `randomAction` **and** for possibly-illegal ones from `randomAnyAction`;
   - the `record` from `apply`/`onResign`/`onTimeout` by any seat is identical for `s` and `s'`
     (whenever the action still validates on `s'`), both with the same recorded draws and, unless
     `publicRandomness` is set, with different draws. This catches drawn tiles leaking into history;
   - **a record doesn't repeat a secret choice**: at each sample the kit draws 8 legal actions from
     `randomAction` for each seat in `toAct`, applies each on the same state with the same draws,
     and groups them by every other seat's view and the public view afterwards; within a group the
     records and their `describe` text are identical. (The comparison on `s'` can't see this: it
     replays the same action, so a record that repeats `action.card` is the same both times.) So
     that a rare kind of action (an exchange, say) is drawn twice often enough, **`randomAction`
     MUST produce every kind of action that is legal at a state at least about a tenth of the
     time**. A module whose public moves leave no trace in any view must show them in `view` (e.g. a
     last-move field), not only in the record.

   Points are sampled **uniformly over each game's length** (the game is played first and its
   samples kept by reservoir sampling), so a leak that appears only late, e.g. once the deck is
   empty, is as likely to be sampled as one at the start. In full mode every tenth game is also
   checked at every step.
4. **Termination**: random play always reaches `result() !== null` within `maxActions(options,
   seats)`, a positive safe integer of at most 1 000 000. Half the games are played with no seat
   leaving, and in the rest a seat leaves with a chance of about 1 / `maxActions` per transition, so
   long games really run to their end.
5. **Turn sanity** (module-checkable): `toAct` ⊆ seats that `seatStatus` reports `playing`; at
   every step every seat in `toAct` has an action that validates (its `randomAction` result is
   checked); a seat reported `out` never returns to `playing` or `toAct`; `toAct` is empty exactly
   when `result()` is non-null. Seats leave the way the framework makes them (§4): a seat that hasn't
   acted declines only when at least `min` playing seats would remain (otherwise the framework
   ends the game itself), and may also resign; only a seat that has acted times out.
6. **CPU budget**: per-call CPU for `validate` + `apply` (and `preview`) on the `worstCase` inputs
   stays within the budget in 08 T25 at the 99th percentile, timed after warm-up runs (100 timed
   runs per input in fast mode, 300 in full). The budget is measured **on the host running the
   kit**; `pnpm games:verify --cpu-budget-ms <n>` sets it (raising it for a host slower than the
   reference hardware, or lowering it). `worstCase` must not be vacuous: it returns at least one
   input for every playable seat count, each input is a game of that seat count (`seatStatus`
   has one entry per seat), its seat is in `toAct` and its action validates.
7. **Isolation between games**: two random games are played interleaved through the same loaded
   engine module and compared with the same games played alone; every view, record, `validate` and
   `preview` result must be identical. This catches module-level state (e.g. a wrongly keyed cache)
   leaking one game's hidden state into another.

The kit has two modes: **fast**, 300 games per rules version spread evenly over its option inputs
and seat counts (rounded up, at least 3 per combination), run by `pnpm build` and the Docker build through
`pnpm games:verify --fast` (`games:verify`, fast or full, never runs in a deploy job, §7.3); and
**full**, 1000 games per option input and seat count, run in CI's test stage and in each game
package's own CI.

The kit itself is tested against deliberately **broken fixture modules** (one leaks hidden state
into a view, one into an error detail, one into a record, one into the public view; one leaks only
late in the game; one only under a non-default option; one orders a view's keys by hidden state;
one repeats a secret choice in its record, and one a rare secret choice; one has a no-op
`perturbHidden`, and one perturbs only the deck while hands are hidden; one reads resources in
`setup`; one is nondeterministic; one never terminates, with a small and with a large
`maxActions`; one leaves `toAct` non-empty after the end; one keeps hidden state in a module-level
variable shared between games; one has an empty and one an illegal `worstCase`): the kit MUST fail
each one, in fast mode.

The framework, not the kit, enforces that only seats in `toAct` may act (05 `/actions`).

Framework and runtime code never reads a definition's `test` hooks; only the testkit and `games:verify`
do. The hooks still ship in every engine (they are part of the contract), so this keeps test-only
code such as a bot or a kit word list out of every request path; a check in `scripts/src/ci`
fails if code under `packages/server/src`, `packages/shared/src` or `apps/*/src` reads them
(findings F-11).

Module-specific tests (rules tables, scoring edge cases) are in addition to the kit.

## 7. Game packages, instance composition and versioning

### 7.1 A game is a package

A game module is an npm package with three entry points (`package.json` `exports`):

| Entry point | Named export | Contents | May import |
|---|---|---|---|
| `<pkg>/engine` | `engines` | One `GameDefinition` per supported rules version (§7.4), as a map `{ [version: number]: GameDefinition }` | `@your-move/sdk` (types, pure helpers, `@your-move/sdk/schema`) and pure code bundled into the package. Nothing else (§7.5) |
| `<pkg>/client` | `client` | The `GameClientModule` (§3) | `@your-move/sdk` (including its client helpers), React, the package's own `/engine` and static assets bundled with it |
| `<pkg>/manifest` | `manifest` | The `GameManifest` (§7.2), a plain data module | Nothing |

A package also ships its own tests, runs the generic test kit (§6) in its own CI, and states its
licence in `package.json` (a permissive licence from the allow-list in 11 §6, or the operator must
accept it explicitly, §7.3).

First-party games live in this repository under `games/<id>/` as workspace packages with exactly
this shape (`@your-move/game-example`, `@your-move/game-words`, `@your-move/game-paths`) and are
published like any third-party game (§7.4). The repository's own build never reaches into a game
package except through these three entry points.

#### 7.1.1 `package.json` and entry-point contract

- **ESM only**, `"type": "module"`. Each entry point is **built JavaScript plus `.d.ts`**
  (TypeScript sources are not consumed): `exports` maps `"./engine"`, `"./client"` and
  `"./manifest"` to objects with `types` and `import` conditions (and nothing else; no `require`,
  no `browser`/`node` forks). Every entry point uses the named export above; no default exports.
- **Nothing else changes how the files are read**: `import` targets end in `.js` or `.mjs` and
  `types` targets in `.d.ts` or `.d.mts`; no `imports` or `browser` field; and nowhere in the
  package another `package.json` (Node and bundlers honour its `imports`, `browser` and `type`),
  a `node_modules` directory (`bundleDependencies`), CommonJS (`.cjs`, `.cts`) or a symlink
  leading out of the package. A package installed from a registry has no `workspace:` ranges
  (publishing replaces them); `games:verify` resolves them only for this repository's workspace
  packages, whose own top-level `node_modules` (pnpm's links) it skips.
- **Dependencies**: `@your-move/sdk`, `zod` and (for the client) `react` are **peerDependencies**
  only (the instance supplies them); the SDK range is the package's statement of compatibility
  (§7.4). An engine may **bundle** pure third-party code into its built output (inlined, e.g. a
  small algorithm library; not as a bundled dependency); bundled code is held to the same rules as the engine's own code. The built
  engine and manifest output import nothing but `@your-move/sdk` and `@your-move/sdk/schema`,
  enforced on built output (§7.5), so an engine never imports a package at runtime even if one is
  installed. A **client** may import the packages it declares in its `dependencies` (subject to the
  licence allow-list, 11 §6); those are the package's only `dependencies`.
- **Built-output rules** (§7.5) are checked on the files the `exports` map points at, so what is
  verified is exactly what runs.

### 7.2 Manifest

```ts
interface GameManifest {
  type: string;            // ^[a-z][a-z0-9]{1,31}$, globally unique within an instance; the game_type stored in rows
  name: string;            // neutral display name ("Words"); no trademarks (CLAUDE.md)
  description: string;     // one line for the new-game picker
  icon: string;            // SVG markup of original artwork, sanitised at build (no scripts, no external references)
  licence: string;         // SPDX id, must equal package.json "license"
  resources: ResourceRequest["kind"][];  // framework resource kinds the engine may request (§2.1 rule 7)
  hiddenInformation: boolean;            // as in GameDefinition (§6.3), declared up front for the catalog and §4
  players: { min: number; max: number }; // overall bounds across all options
  rules: { [version: number]: string };  // the rules as Markdown (no HTML), per rules version; served by the API (05) and the MCP server (§9.4)
  homepage?: string;       // source repository or docs
}
```

SDK compatibility is stated once, by the package's `peerDependencies` range for `@your-move/sdk`;
the manifest doesn't repeat it. The manifest must agree with the engine: the kit checks that
`type`, `hiddenInformation` and the `players` bounds match every exported `GameDefinition`, that
`rules` has an entry for every exported rules version, and that the engine only requests the
resource kinds listed.

### 7.3 Instance composition (build time) and orphaned games (deploy and run time)

Cloudflare Workers can't load code at runtime, so an instance's set of games is fixed when it is
**built**:

- `instance.config.ts` at the repository root (an operator's fork edits it) lists the installed
  game packages and whether each is enabled by default:

  ```ts
  export default defineInstance({
    games: [
      { package: "@your-move/game-words" },
      { package: "@your-move/game-paths" },
      { package: "@your-move/game-example", enabled: false },
      // { package: "@someone/game-hex", acceptLicence: "MPL-2.0" },  // a third-party game
    ],
  });
  ```

  Game packages are ordinary entries in the root `package.json` **`dependencies`** (never
  `devDependencies`), pinned by the lockfile; Renovate identifies them from this list (11 §8).
- `pnpm games:generate` reads the config and generates three files into the git-ignored
  `generated/` directory, never edited by hand and never committed: the **server registry**
  (`type → { manifest, engines }`), the **client import map** (`type → () => import("<pkg>/client")`)
  used for lazy loading, and **`installed.json`**, plain data listing each installed `type` with
  its package name and version and the rules versions its engine exports. It runs from the root
  `prepare` script (so a fresh clone has `generated/` after `pnpm install`), before `pnpm typecheck`,
  `pnpm lint` and `pnpm test`, and from `pnpm build` and `pnpm dev:*` (11 §3). `packages/server` never imports
  them: `apps/worker` and `apps/node` import the server registry and pass it in
  (`createApp({ platform, games })`, 03 §4), and `apps/web` imports the client import map.
- `pnpm games:verify` fails the build when:
  - two packages declare the same `type`, or a type id doesn't match the pattern;
  - the instance's `@your-move/sdk` version doesn't satisfy a package's SDK peer range;
  - a package's licence is outside the allow-list (11 §6) and not accepted in the config with
    `acceptLicence`;
  - a package violates the built-output rules (§7.5) or fails the generic test kit (§6) under the
    instance's SDK;
  - the manifest disagrees with the engine (§7.2), or the manifest icon fails sanitisation.

  `pnpm build` and the Docker build run it in **fast** mode; CI's test stage runs the **full** kit
  (§6). It plays each package's own test hooks (`test.optionInputs`, `test.context`,
  `test.resources`, §6), never just its defaults. A game package in this repository's workspace is built with its own `build` script before
  `games:generate` and `games:verify` read it, so it is checked through its built `exports` like a
  published package; for such a package the file-name rules of §7.1.1 cover the files `pnpm pack`
  would publish, plus every symlink anywhere in it, and names are compared case-insensitively.
- **Bundler-input closure.** `games:verify` records every package file its checks covered
  (`generated/verified-files.json`); the web, Node and Worker builds record the files their
  bundler read (`generated/bundles/<app>.json`); and `pnpm games:check-inputs`, the last step of
  `pnpm build` (`--only web,node` in the Docker build), fails if any bundler input inside an
  installed game package is not a file `games:verify` checked **for that build's role**: the Node
  and Worker builds may read only files the engine and manifest entry points reach (the files the
  engine ESLint rules ran on), the web build also those the client entry point reaches. Each record
  must also contain the entry points its build loads (Node and Worker: every installed package's
  engine and manifest; web: every client entry, from M3, when the web app first imports the client
  map), every package in `installed.json` must appear in `verified-files.json`, and `pnpm build`
  deletes `generated/bundles/` first, so a missing or stale record fails. Built output must name
  the file in every relative import (ending in `.js` or `.mjs`), and a package's published files
  contain no TypeScript or JSX sources (`.ts`, `.mts`, `.tsx`, `.jsx`; declaration files
  excepted), so no resolver can pick a file the checks didn't see. Only **module** inputs are
  covered, not CSS `@import` or `url()` assets. **`games:verify` never runs in a deploy job**, nor
  does anything else that imports game package code: deploy jobs hold deploy credentials (08 §6).
- At runtime `ENABLED_GAMES` (09) still filters which installed types are offered for **new**
  games; an installed but disabled type keeps serving its existing games.

The build can't see an instance's database, so removing a game type or rules version that live
games still use is caught at **deploy and run time**:

- `pnpm games:check-db` lists every `lobby`/`active` game whose `game_type` isn't installed or whose
  `game_version` isn't exported by the installed package. It reads **only** `generated/installed.json`
  (the build stage's artifact) and runs one fixed query; it never imports game package code. The
  Cloudflare deploy job (09 §6) runs it against D1 before `wrangler deploy` and stops on any hit.
  The Node server runs the same check at startup, in this order: migrations → orphan check against
  `installed.json` → read and scrub secrets (§7.5) → dynamic `import()` of the server registry →
  assert the registry's types and versions equal `installed.json` (else refuse to start) → serve. On
  an orphan hit it refuses to start. The operator may override with `--allow-orphans` on the deploy
  step (or `ALLOW_ORPHAN_GAMES=true` for one Node start), which accepts that those games become
  orphaned.
- At runtime an **orphaned** game (no engine for its type or version) answers every write with
  `409 GAME_UNAVAILABLE`, displays from the envelope only ("This game is no longer available"),
  and is cancelled by the sweep (operator cancel semantics, §4, with `final_views` NULL). Finished
  games of a removed type keep displaying from `final_views` and stored `describe` text (§5).

### 7.4 Versions: rules, packages and the SDK

- **Rules versions.** Each game row stores `game_type` and `game_version`. Any change to a module's
  rules or state shape releases a new rules `version`, exported alongside the old ones from
  `/engine`. An old version stays exported while any `lobby` or `active` game may use it (checked by
  `games:check-db`, §7.3); new games always use the latest. Finished games need no engine code. The
  client keeps rendering every version (§3).
- **Package versions** follow semver and are released with Changesets (11 §7): a new rules version
  is a minor release; dropping an old rules version is a major release.
- **Data within a version** (e.g. word-game rulesets, dictionaries) are **options** with their own
  versioning, as defined by the module.
- **The SDK** (`@your-move/sdk`, with `@your-move/testkit`) is the contract between the framework
  and every game. Its only peer dependencies are `zod` (one pinned major, re-exported as
  `@your-move/sdk/schema`) and, for its client helpers, `react`; it has no other dependencies.
  Entry points: `@your-move/sdk` (types and pure helpers, no React), `@your-move/sdk/schema` and
  `@your-move/sdk/client` (the React helpers; never importable from an engine or manifest, §7.5).
  It exports every type a module or client needs, including the client-facing API types
  (`GameEnvelope`, `SubmitResult`, …) as Zod schemas. The server registers these same schemas on its
  routes, so the types `openapi-typescript` generates for `@your-move/api-client` are structurally
  identical; a type-level test asserts the two are mutually assignable.
  - **Until the MVP (M4) the SDK is `0.x`**: any minor may break, with a migration note. This keeps
    the contract changeable while the framework (M3) and the first games exercise it.
  - **From 1.0** it follows semver strictly: **patch** — fixes with no type or behaviour change
    visible to modules; **minor** — additive only (new optional hooks, optional context fields,
    helpers, resource kinds); **major** — anything else (a new required hook, a changed
    signature, a stricter kit check that existing correct modules could fail), with a migration
    note. An instance runs exactly one SDK version; a game whose peer range excludes it can't be
    installed (§7.3), so a major gives game authors a clear upgrade signal rather than a silent
    break.
  - The SDK's public surface is exactly what its entry points export; anything else is internal.
    `@microsoft/api-extractor` reports are committed and checked in CI, so an accidental surface
    change fails the build.
- **Publishing.** All `@your-move/*` packages meant for outside use (`sdk`, `testkit`,
  `api-client`, `mcp`, the first-party games) are published to this project's GitLab package
  registry through its project-level npm endpoint, only from `main`/tags (11 §9). The
  `@your-move` scope is claimed on the public npm registry so nobody else can publish under it
  (Q25), but nothing is released there, so **every install instruction names the registry
  explicitly** — a game author's `.npmrc`:

  ```
  @your-move:registry=https://<gitlab-host>/api/v4/projects/<project-id>/packages/npm/
  ```

  and one-off runs use `npx --registry=<that URL> @your-move/…`, never a bare `npx @your-move/…`
  (which would resolve from npmjs, 08 T29).

### 7.5 Trust model for installed games

Installing a game package means **trusting its code completely**. Its engine runs inside the
server process and its client runs in players' browsers on the app's origin with their sessions.
A malicious game can compromise the whole instance (other games' hidden state, request bodies, on
Node possibly secrets) and the accounts of everyone who plays on it, including admins. There is no
runtime sandbox in v1 (08 T27). What we do is make honest games verifiable and accidental damage
unlikely, and reduce what a dishonest one can reach:

- **Built-output rules shipped in the testkit**, run by `pnpm games:verify` on the files each
  package's `exports` map points at (§7.1.1):
  - a dependency-cruiser ruleset (`@your-move/testkit/depcruise`): an engine or manifest imports
    only `@your-move/sdk` and `@your-move/sdk/schema` (never `@your-move/sdk/client`); a client
    only the SDK (including `/client`), React, its own engine and the packages in its own
    `dependencies`; no `node:*`, no DOM in engines or manifests, no framework packages;
  - an ESLint config (`@your-move/testkit/eslint-engine`) on built **engine and manifest** output
    (manifests are executable JavaScript too): a **globals
    allow-list** (no `fetch`, `crypto`, `globalThis`/`self` access, timers, `Date.now()` or
    `new Date()` without arguments, `Math.random`, `eval`/`Function`, `WebAssembly`, `process`), and
    **no writes to built-in objects or prototypes** — consistent with CLAUDE.md's purity rule.
- **The generic test kit at build time** (§6) under the instance's SDK version, including the
  cross-game isolation check.
- **Licence allow-list** and lockfile integrity (`pnpm install --frozen-lockfile`, 08 §6); game
  packages come only from configured registries, with the registry named explicitly (§7.4).
- **Process hardening on Node** (09 §5): the server runs with
  `--disallow-code-generation-from-strings`; config and secrets are read, then scrubbed from
  `process.env`, **before** the generated game registry is loaded with a dynamic `import()`.
  Workers already forbid code generation from strings.
- **No remote code at runtime:** the CSP is unchanged (08 §3); a game's client assets are bundled
  into the app at build time, never fetched from elsewhere.
- **Operator guidance** (09 §1.3): install third-party games only from authors you trust, review
  the diff on every upgrade like any dependency (Renovate never automerges, 11 §8), and **don't play
  games on an admin account**.

Later hardening (not v1): freezing shared built-ins before engines load (SES `lockdown()`; whether
it works on Workers is unknown and must be tested), and running engines in an isolate (a separate
Worker, `worker_threads`, or a WebAssembly sandbox); the pure, synchronous contract keeps both
options open.

### 7.6 The reference module (`example`)

`@your-move/game-example` is a deliberately small game (a hidden-hand "high card" variant for 2–4
players with one simultaneous secret phase and elimination) that exercises every part of the
contract. It is built in M1 to prove the SDK and the kit, used by the framework's own tests, and
doubles as the **template for third-party game authors**. It is installed but disabled by default.
The guide `docs/guides/writing-a-game.md` (11 §11) walks through it.

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

## 9. AI players and AI assistance

People can connect their own AI agents (for example a coding assistant through MCP, §9.4) to play
or to help them play. The framework treats this as a first-class, clearly labelled feature, not
something to hide.

### 9.1 How an agent acts

An agent never signs in with a browser session. It acts through an **API token** (06 §8) on the
public API (05), exactly like any other client, so it sees only what the seat it acts for may see:
the module's `view` for that seat, public records and `describe` text. Every secrecy rule (§2.1
rule 4, §6.3) therefore covers agents with no extra code.

A move submitted with a token is an **AI move**. The framework records `via = "token"` (otherwise
`"app"`) on the logged action (04 `game_actions`), and the history API returns it with each item
(05), so every client can show it. Tokens are scoped (06 §8): an agent acting on seats it already
holds needs only `read` and `play`; creating games and joining need separate opt-in scopes that an
assistant should never be given.

### 9.2 AI accounts (AI opponents)

- A human may have up to **3 AI accounts** at a time (`users.kind = "agent"`, `owner_user_id` =
  the human), created in Settings with a display name; creating one is limited per day, and every
  creation counts toward the owner's rename budget (06 §5), so delete-and-recreate can't be used as
  a message channel. Only an onboarded owner (not re-prompted, 06 §5) can create AI accounts or
  their tokens, and an AI account's tokens stop working while its owner isn't onboarded. The app
  always shows an AI account as "<owner>'s AI <name>" with an AI badge — in lobbies, headers,
  history, results, invitations and push text — so everyone knows whose agent it is.
- AI accounts have no email address and can't sign in; they act only through tokens their owner
  creates for them (06 §8).
- An AI account is seated **only by its owner, when the owner creates a game** (§4). It is
  auto-joined. Nobody else can pick, invite, add or link-join an AI account, and AI accounts can't
  create games, accept invitations, use join links or hold an invitation in v1.
- Other people see the AI seat, and whose it is, in the invitation and the lobby **before** they
  accept; such games never auto-start (§4).
- In a game type with hidden information, an owner's AI seats may only be used when every other
  seat is one of the owner's own AI accounts (§4): the owner can read their agent's view through its
  token, so mixing it with other humans would let them see a second hand.
- AI accounts never form past-opponent pairs (04 `past_opponents`), never appear in anyone's
  past-opponents list, and can't block or be blocked (their owner's blocks apply instead: an AI
  account is treated as its owner for every block check).
- Deleting the owner deletes their AI accounts (04 §Account deletion). An AI account's own games
  continue to work like any other player leaving: its seats resign through the normal deletion path.
- Per-owner limits (08 §4) bound how many games an owner may create with AI seats, so AI accounts
  can't be used to flood anyone.

### 9.3 AI assistance on human seats

`aiAssistance` (§4) decides whether a **human** seat may be played by that human's agent:

- `off` (the default whenever the game has an open seat or two or more humans, §4): a token
  submitting an action or resign **for a human seat** gets `403 AI_NOT_ALLOWED` (a decline is
  never refused on these grounds: declining gives nobody an advantage, 05). Reading
  your own view and history and asking for previews with a `read`-scoped token is always allowed
  (preview never runs the AI check, 05): an assistant may suggest, the human decides and plays in
  the app.
- `allowed`: a human's token may also submit. Every such move is shown in history as
  AI-assisted ("Sam (with AI) played …"), so it's never hidden from the other players.
- AI accounts' seats (§9.2) always act through tokens; `aiAssistance` doesn't apply to them.

This sets a norm and makes AI help visible; it can't be a guarantee. A determined player could
script their own browser session, or read a suggestion from an agent and type it in. The rules page
says so plainly.

### 9.4 MCP

`@your-move/mcp` is a small local [Model Context Protocol](https://modelcontextprotocol.io) server
(stdio) that a user runs on their own machine with their instance URL and an API token. It is a
thin client of the public API (it uses `@your-move/api-client`) and adds no server-side code. Its
tools: list my games, get a game (envelope + my view), read the rules of a game type
(`GET /api/v1/games/types/:type/rules`, 05), read history, preview a move, submit a move (only where
§9.3 allows, or for an AI account), and list my invitations. It never creates games, joins or
accepts.

- **Token handling**: the token is read from a file (mode 0600, e.g.
  `~/.config/your-move/token`) or the OS keychain, never from the agent client's JSON config; the
  server refuses non-`https` instance URLs except `localhost`. By default it **refuses tokens with
  any scope beyond `read` and `play`** (and always refuses `admin` tokens); the docs recommend an
  AI account's token, or a short-lived personal one.
- **Untrusted data**: the whole `view`, every history record and every `describe` text, display
  name and game name reach the agent wrapped as **untrusted data** between explicit delimiters
  (third-party game views may contain text other players chose), and the tool descriptions warn the
  agent that such text may contain instructions it must not follow (prompt injection, 08 T28).

The MCP server is its own milestone (10 M8). Its acceptance runs **scripted** MCP-client tests
(no language model): the owner against one of their own AI accounts in `words`, and the owner with
two of their own AI accounts in `paths`, each to the end. Agents driven by a language model playing
real games is a manual exploratory check the maintainers run, not a CI gate.

## 10. Out of scope (framework v1)

Spectators, chat, real-time (timed) play, tournaments, cross-game stats, accounts for children
without email (Q20, roadmap M7), AI accounts creating or joining games on their own (§9.2), and
running game engines in a sandbox (§7.5). The contract above shouldn't block any of them.
