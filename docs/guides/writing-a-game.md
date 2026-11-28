# Writing a game

This guide is for authors of game packages: a game you write in your own repository, publish to a
registry, and that an operator installs into their instance of the platform. It walks through the
reference game, `@your-move/game-example` (in this repository under `games/example/`), which is
deliberately small and exercises every part of the contract: 2–4 players, a hidden hand, one
simultaneous secret phase per round, and elimination. Where the example is too small to show
something, the guide points at the second reference game, `@your-move/game-paths` (`games/paths/`):
2–8 players on a shared public board, a hidden deck and hands, a rule the engine and the client
share, and a board drawn as SVG. It is a good model of a full game and of what the kit and the
reviews caught while it was built.

The contract itself is specified in [`docs/spec/02-game-framework.md`](../spec/02-game-framework.md)
(cited below as "02 §n"); engineering rules are in
[`docs/spec/11-engineering.md`](../spec/11-engineering.md). Where this guide and the spec disagree,
the spec wins.

## 1. What a game package is

A game is an npm package with three entry points (02 §7.1):

| Entry point      | Named export | Contents                                                                 | May import                                                                                      |
| ---------------- | ------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `<pkg>/engine`   | `engines`    | One `GameDefinition` per supported rules version: `{ 1: definition, … }` | `@your-move/sdk` and `@your-move/sdk/schema` only, plus your own pure code                      |
| `<pkg>/client`   | `client`     | The `GameClientModule`: board, options form, rules sheet, history items  | `@your-move/sdk` (including `/client`), React, your own engine, your package's own dependencies |
| `<pkg>/manifest` | `manifest`   | The `GameManifest`: type id, name, icon, licence, player bounds, rules   | Nothing                                                                                         |

The **engine** runs inside the server. It is pure TypeScript: no I/O, no clock, no `Math.random`,
no `crypto`, no timers, no DOM. Randomness arrives as a `RandomSource` argument. The **client** is
a set of React components the web app lazy-loads; it never talks to the API itself, only through
the `submit` and `preview` callbacks the platform's game shell gives it. The **manifest** is plain
data the platform reads without loading any of your code.

**Trust model (02 §7.5).** Installing a game means trusting its code completely: the engine runs
in the server process, the client runs in players' browsers with their sessions. There is no
runtime sandbox. What the platform does instead is make honest games verifiable: the built-output
rules and the generic test kit (section 4) run on every install, so accidental damage — a leaked
hand, a nondeterministic engine, a stray `fetch` — fails the operator's build rather than reaching
players. Operators are told to install games only from authors they trust and to review every
upgrade like any other dependency.

## 2. Setting up a game repository

Start from a copy of `games/example/` and rename it. The platform's packages are published to a
GitLab package registry, never to the public npm registry, so name the registry explicitly in your
repository's `.npmrc`:

```ini
@your-move:registry=https://<gitlab-host>/api/v4/projects/<project-id>/packages/npm/
```

For one-off commands use `npx --registry=<that URL> @your-move/…`; never a bare
`npx @your-move/…`, which would resolve from the public registry (02 §7.4).

Your `package.json` (02 §7.1.1):

```json
{
  "name": "@you/game-mygame",
  "version": "0.1.0",
  "license": "BSD-2-Clause",
  "type": "module",
  "sideEffects": false,
  "exports": {
    "./engine": { "types": "./dist/engine/index.d.ts", "import": "./dist/engine/index.js" },
    "./client": { "types": "./dist/client/index.d.ts", "import": "./dist/client/index.js" },
    "./manifest": { "types": "./dist/manifest.d.ts", "import": "./dist/manifest.js" }
  },
  "files": ["dist", "!dist/**/*.test.*", "!dist/test-support.*", "!dist/.tsbuildinfo"],
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "lint": "eslint . && depcruise --config .dependency-cruiser.mjs dist"
  },
  "peerDependencies": {
    "@your-move/sdk": "^0.1.0",
    "react": "^19.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@your-move/sdk": "0.1.0",
    "@your-move/testkit": "0.1.0",
    "dependency-cruiser": "…",
    "eslint": "…",
    "react": "…",
    "typescript": "…",
    "vitest": "…",
    "zod": "…"
  }
}
```

The rules that matter:

- **ESM only**, and each entry point is **built JavaScript plus `.d.ts`**. `exports` maps each
  entry point to exactly `{ types, import }`: no `require`, no `browser`/`node` forks, no `imports`
  field, no nested `package.json`, no CommonJS, no bundled `node_modules`.
- **`@your-move/sdk`, `zod` and `react` are peer dependencies**: the instance supplies one copy of
  each. Install them as dev dependencies too, to build and test. The SDK peer range is your
  statement of compatibility (section 6).
- **Only your client may have `dependencies`**, and only permissively licensed ones. The built
  engine and manifest import nothing but `@your-move/sdk` and `@your-move/sdk/schema`; if your
  engine needs a small pure library, bundle it into the built output.
- `license` must equal the manifest's `licence`.

The example's TypeScript setup: `tsconfig.json` is a solution file referencing `tsconfig.src.json`
(the package sources, `rootDir: "src"`, `outDir: "dist"`, `jsx: "react-jsx"`, the DOM libraries for
the client) and `tsconfig.config.json` (config files such as `vitest.config.ts`, type-checked but
never built). Use strict settings; the platform's own are in 11 §2.

## 3. Writing the engine

The engine is a `GameDefinition<Options, State, Action, View, PublicRecord, PreviewResult>`
(02 §2). The example splits it into small modules under `src/engine/`:

| Module          | Holds                                                                      |
| --------------- | -------------------------------------------------------------------------- |
| `schemas.ts`    | Constants, every Zod schema and the types inferred from them, error codes  |
| `options.ts`    | `resolveOptions`, `catalog`, `validateStart`: game creation                |
| `state.ts`      | The `State` type, `setup`, the rules (`playCard`, `removeSeat`), `result`  |
| `present.ts`    | `view`, `summary`, `describe`                                              |
| `kit-hooks.ts`  | The `test` hooks the generic kit drives the game with                      |
| `definition.ts` | `validate`, `preview` and the `GameDefinition` object that wires it all up |
| `index.ts`      | `export const engines = { 1: exampleV1 } satisfies GameEngines;` and types |

### Schemas

Every value that crosses the contract has one Zod schema, built with the Zod that
`@your-move/sdk/schema` re-exports. Never import `zod` directly (the built-output rules reject it).

```ts
import { z } from "@your-move/sdk/schema";

export const actionSchema = z.object({ card }).strict();
export type Action = z.infer<typeof actionSchema>;
```

**Bound the view and record schemas by construction.** They describe what is sent to every client and
stored in every history, so give every array in `viewSchema` and `recordSchema` a `.max(…)` that
the rules guarantee (the most seats, the largest board, the longest path), every integer a range, and
every object `.strict()`. Derive each bound from the same constants the engine uses (paths takes them
from its seat range, board sizes and hand sizes), so a bound can't drift from a rule. A schema with no bounds lets one
bad value grow without limit.

### Options

`resolveOptions(input, ctx)` turns the creator's partial, untrusted input into complete options,
filling defaults; anything else is an error value. `catalog(ctx)` tells the new-game form the
ranges and defaults; `validateStart(options, seats)` refuses a seat count the options can't
support.

**Resolved options must be a valid input** (02 §2.1 rule 10): `resolveOptions(options, ctx)` for
options your module resolved itself must return them unchanged under the same `ctx`. A rematch
resolves a finished game's stored options this way, so later the same choices come back at their
current versions, or are refused with your normal error. Top-level option keys ending in `Version`
are reserved for versions: don't use that suffix for any other option. If your options carry
versions, name each key `<name>Version` (e.g. `rulesetVersion`), accept it in the input and **ignore** it: check its
shape (a non-negative integer, say) but **never honour** it, so no input can pin an old version;
always resolve the current one. The kit checks the round trip for every option input, on a copy of
the options, and fails a module that changes its input. The platform leaves `*Version` keys out of
the options it remembers for each player.

```ts
export function validateStart(options: Options, seats: number): Ok | GameError {
  const needed = seats * options.handSize;
  return needed <= DECK_SIZE
    ? OK
    : { code: ERROR_CODES.deckTooSmall, detail: { needed, deckSize: DECK_SIZE } };
}
```

**Errors are values, never exceptions** (02 §2.1 rule 3). Every code you return must be listed in
`errorCodes` and must not be one of the platform's reserved codes (`RESERVED_ERROR_CODES` in the
SDK: `INVALID_OPTIONS`, `NOT_YOUR_TURN`, `ALREADY_ACTED`, …). An exception means a bug and reaches
the player as a generic server error.

### State and randomness

State is plain JSON data — the platform stores it as JSON — and every transition returns a new
state without changing its input. Randomness comes only from the `rng` argument; the SDK's
`shuffle(items, rng)` is an unbiased Fisher–Yates shuffle:

```ts
export function setup(ctx: { options: Options; seats: number; rng: RandomSource }): State {
  const { options, seats, rng } = ctx;
  const deck = shuffle(
    Array.from({ length: DECK_SIZE }, (_, i) => i + 1),
    rng,
  );
  const hands = Array.from({ length: seats }, () =>
    deck.splice(0, options.handSize).sort(ascending),
  );
  // …
}
```

Transitions get an `rng` too and may draw from it: when the example's deck can't give every playing
seat a card, the face-down cards of seats that left are shuffled back in with `shuffle(…, rng)`.
The platform records every value drawn and replays a game from its log, so the same state, action
and draws must always give the same result. Keep no module-level mutable state: one loaded engine
serves many games at once, and the kit plays games interleaved to catch leaks between them. The
engine lint rules don't forbid a module-level `let` or a cache in a `Map`, so nothing stops you
writing one; it breaks isolation and determinism all the same, so don't. For the same reason the
engine's globals allow-list leaves out every blocking or concurrent primitive (`Atomics`,
`SharedArrayBuffer`, `Worker`, `WebAssembly`). They must stay off: the CPU budget (below) counts
only CPU time of the calling thread, so an engine that waited or handed work elsewhere would pass
the check and still stall the server (02 §6.6, 08 T25).

### Turns: `toAct`

`toAct(state)` returns the **set** of seats that may act now (02 §2.3), and `[]` exactly when the
game is over. The example's rounds are one simultaneous secret phase: every playing seat that
hasn't played this round is in `toAct`, and each play is its own transition, in any order:

```ts
export function toAct(state: State): Seat[] {
  if (state.endReason !== null) return [];
  return playingSeats(state).filter((seat) => state.pending[seat] === null);
}
```

Never put a seat in `toAct` that has no legal action; skip it yourself.

### `validate` and `apply`

`validate(state, seat, action, resources)` says whether the action is legal; `apply` performs it
and returns `{ state, record }`. `validate` always runs first, and it must never throw for any
schema-valid action — the kit feeds it plenty of illegal ones. Its answer, including any error
`detail`, may depend only on what that seat can see:

```ts
function validate(state: State, seat: Seat, action: Action): Ok | GameError {
  if (state.endReason !== null) return { code: ERROR_CODES.gameOver };
  if (state.status[seat] !== "playing") return { code: ERROR_CODES.notPlaying };
  if (state.pending[seat] !== null) return { code: ERROR_CODES.alreadyPlayed };
  if (!at(state.hands, seat).includes(action.card)) return { code: ERROR_CODES.notInHand };
  return OK;
}
```

Only `validate` and `preview` receive resources (such as a dictionary); `setup`, `apply`,
`onResign` and `onTimeout` must not depend on them, so replay works after a resource changes.

### Views and secrecy

`view(state, viewer)` is the **only** way state reaches a client; `viewer` is a seat or `null` for
the public view. While the game is in progress, `view`, `summary`, `toAct`, `seatStatus`, whether
`result()` is null, and `validate`/`preview` results must not depend on anything hidden from that
seat (02 §2.1 rule 4). The example shows a viewer its own hand and its own secret play, and of the
others only counts, lives, points, and _whether_ they have played this round:

```ts
seats: state.status.map((status, seat) => ({
  status,
  lives: at(state.lives, seat),
  points: at(state.points, seat),
  handCount: at(state.hands, seat).length,
  played: state.pending[seat] !== null,
  hand: over || seat === viewer ? [...at(state.hands, seat)] : null,
})),
```

A secret action stays in state, hidden by `view`, until the phase ends; then the revealed round is
part of every view (`lastRound`). Once `result()` is non-null the view may reveal anything (the
example shows every hand).

### Public records

Every transition returns a public `record`, which goes into the game's history and notifications;
`describe(record)` turns it into display text. **A record may contain only what every seat can
see, and nothing that depends on hidden state or on random draws** (02 §2.1 rule 5, §6.3). The kit
enforces this strictly: it randomises everything a viewer can't see (`perturbHidden`), repeats the
transition, and requires the identical record — and, unless your game declares
`publicRandomness` (dice), it repeats it with different random draws too. So a record must not
contain the card played, the cards revealed when a round resolves, who scored or lost a life in
that transition, or what anyone drew. The kit also plays two different legal actions by the same
seat on the same state: if every other seat's view and the public view come out identical, the two
records and their `describe` text must be identical too, so a record can't repeat a secret choice.
(If a public move leaves no trace in any view, show it in the view, for example as a last-move
field.) **Name in a record only what every seat may know.** An outcome that depends on hidden state
reaches players through `view`, as the example's round result does. `paths` shows the line: its
records carry the tile placed (it is on the public board), the public movement it caused and who
went out or was skipped, and never a drawn tile, the deck or a hand; where a public outcome does
disclose something about a hand (a player put out under the default rule had no safe tile), the
rules text says so (paths §3). Views are compared as the JSON clients receive, key order included: build them with a fixed
key order, never one that depends on hidden state. The example's records are only:

```ts
{ kind: "played", seat, round } | { kind: "resigned", seat } | { kind: "declined", seat } | { kind: "timedOut", seat }
```

and the outcome of a round reaches players through `view().lastRound`.

### Leaving the game

The platform owns resignations, declines and timeouts (02 §4) and tells the engine:

- `onResign(state, seat, rng, reason)` with `reason` `"resign"`, or `"decline"` for a seat leaving
  before its first action. A decline removes the seat exactly like a resignation, but its record
  and text must say the player _declined_ ("declined the game"), never "resigned", and nothing may
  present it as a loss (02 §2.1 rule 9).
- `onTimeout(state, seat, rng)` for a seat that ran out of time after acting at least once.

In the example the seat is out, its hand and any secret play are discarded face down, and if it was
the last seat still to play, the round resolves. If one seat is left, the game ends.

### Results

`result(state)` is `null` while the game is in progress, then `{ ranking, endReason }`. Rankings
use standard competition ranking: tied seats share a rank and the next rank skips (1, 2, 2, 4).
Rank every seat; the platform removes seats that declined and re-ranks the rest.
`seatStatus(state)` reports each seat `"playing"` or `"out"`, and a seat that is out never comes
back.

### The kit hooks

The `test` object drives the generic kit (02 §6):

- `randomAction(state, seat, rng, res)`: a legal action (the kit checks that it validates). It
  must produce **every kind of action legal at that state at least about a tenth of the time**
  (play, pass, exchange, …): the kit compares the records of several of them to catch a record
  that repeats a secret choice, and a rare kind it never draws twice is never checked.
- `randomAnyAction(state, seat, rng)`: schema-valid, often illegal, biased to near-legal (the
  example mostly picks a card in hand, sometimes any card or one already played).
- `perturbHidden(state, viewer, rng)`: re-deals at random everything `viewer` can't see while
  keeping the state consistent — same cards overall, same hand sizes, same "has played" flags.
  For `null`, everything hidden from the public. Keep the state's key order (build the new state
  from the old one, as `{ ...state, deck }` does): views are compared key order included. The kit
  counts a perturbation only if it changes what some _other_ viewer sees (another seat's hand,
  say), and at least half of them must. If no seat ever sees your hidden information (only the deck
  order is hidden), set `hiddenFromEveryone: true`, and the kit counts perturbations that change
  the state instead. **The kit can't tell if your perturbation stops covering a hidden part**: a
  hook that leaves the deck alone passes as long as hands change, and the secrecy check then never
  tests the deck. Write a test that it changes every hidden part, in every phase (paths'
  `kit-hooks.test.ts` checks that the deck order itself changes, for the public viewer, a viewer
  whose is the only hand and a finished game), and that it keeps the multiset of cards.
- `hiddenInformation`: whether anything is ever hidden (must match the manifest).
- `maxActions(options, seats)`: an upper bound on transitions in a game, for the termination
  check: a whole number from 1 to 1 000 000, as tight as you can prove it.
- `worstCase(options, seats, rng)`: the most expensive `{ state, seat, action }` inputs, for the
  CPU budget check. Each must be a real move (its seat in `toAct`, its action valid), and every
  playable seat count needs at least one. **Make it honest**, because the budget check is only as
  good as the inputs you hand it, and the kit can't find a worse one for you:
  - Cost a candidate by what `validate` and `apply` actually do for it, including any search they
    make over the hand (paths counts the tiles `validate` traces, plus every tile and rotation in
    hand when a move that puts the mover out makes `validate` look for a safe one).
  - Search for it: play seeded games to their end, cost every move on the way, and keep the
    costliest few. Use enough games. With 6, paths' inputs at 3 and 8 players were four to five
    times cheaper than positions random play reaches; it plays 150 per seat count, which adds
    about a second to a fast kit run.
  - Keep distinct states (not four moves from one position), and keep the costliest move of each
    kind that matters (paths also keeps the costliest that eliminates the mover).
  - It is a heuristic, not a proof. Say so in your spec or comments, and measure how far under
    the budget your engine runs.
- `optionInputs(ctx)` (required): the option inputs the kit plays, each with every seat count your
  options allow. List the defaults (`{}`) and enough others to reach every rule an option changes:
  each ruleset or variant and the corners of each range. The kit can't tell whether you covered
  your options (`[{}]` passes), so this is on you. The example lists six.
- `context()` (optional): the configuration and resource catalog `resolveOptions`, `catalog` and
  `checkConfig` see in the kit; by default your `configSchema` parsed from `{}`, and no resources.
- `resources(options)` (optional): the resources `validate` and `preview` get in the kit's games,
  e.g. a small dictionary for a word game; by default none. Replay always gets none.

## 4. Testing

### The generic test kit

Every game package must pass `@your-move/testkit` (02 §6): schema conformance, replay, secrecy by
perturbation, termination, turn sanity, the CPU budget and isolation between games. Run it in
Vitest:

```ts
import { runKit } from "@your-move/testkit";
import { expect, it } from "vitest";

import { engines } from "./engine/index.js";
import { manifest } from "./manifest.js";

it("passes the generic test kit", () => {
  expect(runKit(engines, { mode: "fast", manifest }).failures).toEqual([]);
});
```

Use `mode: "fast"` while developing (300 games per rules version, spread over your option inputs
and seat counts) and `mode: "full"` in CI (1000 games per option input and seat count, a tenth of
them checked for secrecy at every step). The kit plays the option inputs your `test.optionInputs`
lists, with your `test.context` and `test.resources`, at every seat count `players(options)`
allows and `validateStart` accepts; the operator's `games:verify` plays exactly the same hooks. Secrecy is checked at points spread evenly over each game, early
and late alike. A failure names the property and the seed, so you can replay it. The kit also
checks that the manifest agrees with the engine: the type, `hiddenInformation`, player bounds
(exactly the union of the engine's bounds over your option inputs), rules text for every exported
version, and the resource kinds.

The CPU budget (5 ms per call at the 99th percentile) is the one check whose result depends on the
host: it is measured on the machine running the kit, so a game within budget on your machine can
fail on a slower one. Pass `cpuClock: threadCpuClock().now` (from `@your-move/testkit/cpu-clock`)
to `runKit` in your kit test, as `games:verify` does: the kit then times your engine in this
thread's CPU time, so a busy machine doesn't fail it (without a clock it uses the wall clock;
`paths` failed at 7–10 ms for moves that cost 0.2–0.5 ms before it did this).
Each timed sample is the median of five back-to-back runs, so a run or two that a garbage
collection slowed don't fail the game, but code slow on most calls still does.
`games:verify --cpu-budget-ms <n>`, the `cpuBudgetMs` option of `runKit`, or the
`KIT_CPU_BUDGET_MS` environment variable (a whole number of milliseconds from 1 to 50, read by
every kit run not given a budget, so set it once for a slow CI runner) sets the budget, raising it
for a slow host or lowering it to keep headroom; don't raise it to hide a slow engine. If a test of
yours asserts on the budget, name the one you mean (`cpuBudgetMs: 5`) rather than relying on the
default, because a CI that sets `KIT_CPU_BUDGET_MS` changes what an unnamed run uses.

A fast kit run plays hundreds of games, so give the Vitest test a **measured timeout**, not the 5 s
default, and don't add retries (ADR 0004). Time it alone on your machine, and set the timeout for a
CI runner that may be 100 times slower on CPU-bound work; `games/paths/src/kit.test.ts` shows the
reasoning in a comment (about 10 s alone, 300 s allowed).

### The built-output rules

The operator's `games:verify` checks your **built** files — exactly what `exports` points at — so
check them yourself before publishing. Imports, with dependency-cruiser (`.dependency-cruiser.mjs`):

```js
import { gamePackageRules } from "@your-move/testkit/depcruise";

export default {
  forbidden: gamePackageRules({
    engineEntry: "^dist/engine/index[.]js$",
    clientEntry: "^dist/client/index[.]js$",
    manifestEntry: "^dist/manifest[.]js$",
    ownFiles: "^dist/",
    // The packages in your package.json "dependencies", which only the client may import.
    clientDependencies: [],
  }),
  options: {
    // Resolve through package.json "exports" the way Node and bundlers do; without this the SDK's
    // entry points don't resolve and every import of them is reported.
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "default"] },
  },
};
```

and run `depcruise --config .dependency-cruiser.mjs dist`. Globals, with the engine ESLint config
on the built engine and manifest (`eslint.config.js`):

```js
import { engineEslintConfig } from "@your-move/testkit/eslint-engine";

export default [...engineEslintConfig(["dist/engine/**/*.js", "dist/manifest.js"])];
```

It allows only ECMAScript built-ins (no `fetch`, `crypto`, `globalThis`, timers, `Date.now()`,
`Math.random`, `eval`, `process`, …), requires built-ins to be used by name, and forbids writes to
built-in objects and prototypes. Apply the same config to your engine sources for early warnings.

### Your own tests

The kit checks the contract, not your rules. Write table-driven tests per rule, with a seeded
`RandomSource` (the testkit exports `seededRandom(seed)`). The example's tests cover dealing,
secret plays, round resolution, elimination, every way of leaving, the end conditions, the ranking
with ties, views and secrecy, errors and options; engine code is held to 95 % line and branch
coverage, client code to 80 % lines. Tests of the hooks themselves belong here too (`worstCase`
returns real moves for every seat count; `perturbHidden` changes every hidden part).

## 5. Writing the client

The client module (02 §3) is a `GameClientModule<Options, Action, View, PreviewResult>`:

```ts
export const client: GameClientModule<Options, Action, View, PreviewResult> = {
  type: "example",
  versions: [1],
  OptionsForm,
  Board,
  RulesSheet,
  HistoryItem,
};
```

- **`Board({ game, view, submit, preview })`** renders the viewer's `view` and calls `submit(action)`
  to act; `submit` resolves to `{ ok: true, game, view }` or `{ ok: false, error }`. The example
  shows the hand as real `<button>`s with `aria-pressed`, so choosing a card is keyboard- and
  screen-reader-accessible, and asks for confirmation before the play is sent.
- **Previews.** `preview(action)` asks for a non-authoritative preview (the example's says which
  cards you would keep). You may compute previews locally by importing your own engine, but the
  server's answer to `submit` is the only one that counts. Ignore a preview answer that arrives
  after the player has changed their mind.
- **`OptionsForm({ catalog, value, onChange })`** edits the creator's _unresolved_ input, using your
  part of the catalog for ranges and defaults; the server resolves it with `resolveOptions`.
- **`RulesSheet({ options, gameVersion })`** shows the rules for that game's rules version. The
  manifest's rules are Markdown; render them as text, never as HTML. The example splits them into
  headings, lists and paragraphs and renders each as plain React text.
- **`HistoryItem({ record, describe, gameVersion, names })`** renders one public record. The
  example parses it with its record schema and renders `formatText(describe(record), names)` from
  `@your-move/sdk/client`; for a record or rules version it can't read, it falls back to the
  entry's stored `describe` text.

No
`dangerouslySetInnerHTML`, no inline scripts, no resources fetched from anywhere: your client is
bundled into the app at build time. Keep rendering support for every rules version you have ever
released, so finished games still display. Test components with Testing Library and jsdom.

### Lessons from a larger board

`paths` has a board of squares, a drawn tile for every move and up to eight players, which is where
the small example stops being a guide. What its reviews turned up:

- **Share rules between engine and client; don't copy them.** If the client needs a rule to preview
  a move or to say why a tile is unsafe, export the pure function from the engine (paths exports
  `selfElimination` and `movement`) and call it from the client, so the two can't disagree. Give
  the function only what the client has: the viewer's `view`, never the full state. Then test the
  client's use against the server's rule with a property test: play seeded games, and at each turn
  compare what the client computes from the viewer's view with `validate` and the engine's legal
  moves on the real state (`games/paths/src/client/rule.test.ts`). Your client may import your own engine (section 1).
- **CSS goes in a constructable stylesheet.** The page's content security policy allows no inline
  styles, so a `<style>` element or a `style` attribute is blocked. Build one `CSSStyleSheet`,
  fill it with `replaceSync`, add it to `document.adoptedStyleSheets` once per page, and say so to
  the player if the browser can't (`games/paths/src/client/styles.ts`). Follow the shell's light and
  dark theme, and never let colour be the only signal (paths gives markers a shape each).
- **Draw SVG as React elements**, with `viewBox` and class names, never as a string put into the
  page; decorative drawings get `aria-hidden="true"` and `focusable="false"`.
- **Give every control and every part of the board an accessible name** that says its state in
  words ("Row 2, column 5, empty, your marker faces this square"; "Tile 3 of 3, rotated 90 degrees;
  your marker would survive"), keep the board a region, and announce changes in a polite live
  region. Use real `<button>`s and fieldsets, as the example does.
- **Touch targets are at least 44 × 44 CSS px**, including buttons that are only part of a
  drawing. Paths sizes its squares in `pt` and its marker-phase buttons separately in CSS px; measure
  the targets in CSS px, in your tests and in the e2e.
- **Respect `prefers-reduced-motion`**: skip the animation and show the end state. **Cap the
  animation**: a replay of everyone's movement can be long, so give the whole replay a frame budget
  and share it between the moves (paths: 90 frames of 40 ms, property-tested over long replays).
- **Tell apart players who share a display name.** The platform lets two people use the same name,
  so a board or history that says only "Ann" can mean either. Add the thing that tells them apart
  (paths adds the marker's look: "Ann (orange square)") in every text, the history included.

### End-to-end tests

The unit tests can't show a game works for several people on phones. If you test against a platform
checkout, `tests/e2e/` plays real games, and `tests/e2e/src/paths.spec.ts` is the model for a
multi-player game:

- the `crowd` fixture opens extra signed-in players on top of `page` and `friend`, all with the
  project's device settings, collects every one's content-security-policy violations, and closes
  them all, so a game with four players uses `page`, `friend` and `crowd`;
- turn touch on (`test.use({ hasTouch: true, isMobile: true })`) and use screens from the smallest
  phone up, so a target under 44 CSS px or a board that doesn't fit fails the test;
- read state from the page, not from a copy kept in the test: who is to act, which players are out,
  how many tiles are on the board. A test that tracks the game itself breaks when the rules do,
  and can pass while the page is wrong.

## 6. Versions

- **Rules versions.** Each game stores its rules version. Any change to the rules or to the state
  shape is a new rules version, exported alongside the old ones: `engines = { 1: v1, 2: v2 }`. Keep
  an old version while live games may use it; new games always use the latest. Add the new
  version's rules text to the manifest (`rules: { 1: …, 2: … }`) and to `client.versions`.
- **Package versions** follow semver: a new rules version is a minor release; dropping an old one
  is a major release.
- **The SDK.** Your `@your-move/sdk` peer range is your statement of compatibility; an instance runs
  exactly one SDK version and refuses to install a game whose range excludes it. The SDK is `0.x`
  until the platform's MVP: any minor may break (with a migration note), so pin your peer range to
  one minor (`^0.1.0`) and test against each new minor before widening it.

## 7. Publishing and installing

Publish your built package to a registry the operator can reach, with the registry named
explicitly as in section 2. An operator installs it by:

1. adding it to the root `package.json` **`dependencies`** of their instance (never
   `devDependencies`), pinned by the lockfile;
2. listing it in `instance.config.ts`:

   ```ts
   export default defineInstance({
     games: [
       { package: "@you/game-mygame" },
       // { package: "@you/game-other", acceptLicence: "MPL-2.0" }, // a licence outside the allow-list
     ],
   });
   ```

3. running `pnpm build`, which runs `pnpm games:generate`, `pnpm games:verify --fast` (the kit's
   fast mode: 300 games per rules version, with your package's own test hooks), the app builds,
   and finally `pnpm games:check-inputs`. Verification fails on a duplicate or invalid type id, an
   SDK peer range the instance doesn't satisfy, a licence outside the allow-list that isn't
   accepted, a built-output rule violation (including a relative import that doesn't name its
   `.js` file, or TypeScript or JSX sources in the package), a kit failure, a manifest that
   disagrees with the engine, or an icon that fails sanitisation. `games:check-inputs` then fails
   if a bundler read any file of your package that verification didn't check for that build: the
   server builds may read only what your engine and manifest reach, the web build also what your
   client reaches. CI runs the full kit (1000 games per option input and seat count) with
   `pnpm games:verify`.

At runtime the operator's `ENABLED_GAMES` setting decides which installed games are offered for new
games.

## 8. Checklist before you publish

- [ ] `engines`, `client` and `manifest` are named exports of `./engine`, `./client` and `./manifest`;
      `exports` has exactly `{ types, import }` per entry and points at built `.js` and `.d.ts`.
- [ ] `@your-move/sdk`, `zod` and `react` are peer dependencies; only the client has
      `dependencies`, all permissively licensed; `license` equals the manifest's `licence`.
- [ ] The manifest's type id matches `^[a-z][a-z0-9]{1,31}$`; its name and artwork are your own (no
      trademarked names or looks); its icon uses basic SVG shapes only — no scripts, `style`,
      event handlers, links or `foreignObject`.
- [ ] Rules text exists for every exported rules version, as Markdown without HTML.
- [ ] The engine is pure: no I/O, clock, `Math.random`, `crypto`, timers or DOM; randomness only
      from `rng`; no module-level mutable state; state is plain JSON.
- [ ] View and record schemas are bounded: every array has a `.max`, every number a range, every
      object `.strict()`.
- [ ] Errors are values with codes listed in `errorCodes`, none reserved; `validate` never throws
      for a schema-valid action.
- [ ] Records and `describe` text carry nothing hidden and nothing drawn; a decline says
      "declined", never "resigned".
- [ ] `test.optionInputs` lists the defaults and every option set that changes a rule, and
      `runKit(engines, { mode: "full", manifest, cpuClock: threadCpuClock().now })` reports no
      failures.
- [ ] `worstCase` costs what `validate` and `apply` do, searches enough games and keeps distinct
      states; a test shows `perturbHidden` changes every hidden part; the kit test has a measured
      timeout and names any CPU budget it asserts on.
- [ ] Built relative imports name their files (`./rules.js`, not `./rules`), and the published
      files hold no `.ts`, `.tsx` or `.jsx` sources.
- [ ] dependency-cruiser and the engine ESLint config pass on the built output.
- [ ] Your rules tables pass, with coverage at 95 % for the engine and 80 % for the client.
- [ ] The client shares engine rules instead of copying them (with a property test against
      `validate`), styles itself through a constructable stylesheet, names every control, has 44 px
      touch targets, honours `prefers-reduced-motion`, caps its animation and tells apart players
      who share a name.
- [ ] A changed rule or state shape is a new rules version, and the old one is still exported.
- [ ] Install instructions name your registry explicitly.
