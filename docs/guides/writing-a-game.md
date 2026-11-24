# Writing a game

This guide is for authors of game packages: a game you write in your own repository, publish to a
registry, and that an operator installs into their instance of the platform. It walks through the
reference game, `@your-move/game-example` (in this repository under `games/example/`), which is
deliberately small and exercises every part of the contract: 2–4 players, a hidden hand, one
simultaneous secret phase per round, and elimination.

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

### Options

`resolveOptions(input, ctx)` turns the creator's partial, untrusted input into complete options,
filling defaults; anything else is an error value. `catalog(ctx)` tells the new-game form the
ranges and defaults; `validateStart(options, seats)` refuses a seat count the options can't
support:

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
serves many games at once, and the kit plays games interleaved to catch leaks between them.

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
field.) Views are compared as the JSON clients receive, key order included: build them with a fixed
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

- `randomAction(state, seat, rng, res)`: a legal action (the kit checks that it validates).
- `randomAnyAction(state, seat, rng)`: schema-valid, often illegal, biased to near-legal (the
  example mostly picks a card in hand, sometimes any card or one already played).
- `perturbHidden(state, viewer, rng)`: re-deals at random everything `viewer` can't see while
  keeping the state consistent — same cards overall, same hand sizes, same "has played" flags.
  For `null`, everything hidden from the public. It must actually change the state most of the
  time. The kit counts a perturbation only if it changes what some _other_ viewer sees (another seat's
  hand, say), unless no perturbation ever changes any view (hidden deck order only).
- `hiddenInformation`: whether anything is ever hidden (must match the manifest).
- `maxActions(options, seats)`: an upper bound on transitions in a game, for the termination
  check: a whole number from 1 to 1 000 000, as tight as you can prove it.
- `worstCase(options, seats, rng)`: the most expensive `{ state, seat, action }` inputs, for the
  CPU budget check. Each must be a real move (its seat in `toAct`, its action valid), and every
  playable seat count needs at least one.
- `optionInputs(ctx)` (required): the option inputs the kit plays, each with every seat count your
  options allow. List the defaults (`{}`) and enough others to reach every rule an option changes:
  each ruleset or variant and the corners of each range. The example lists six.
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
allows and `validateStart` accepts; the operator's `games:verify` plays exactly the same hooks, so
what passes for you passes there. Secrecy is checked at points spread evenly over each game, early
and late alike. A failure names the property and the seed, so you can replay it. The kit also
checks that the manifest agrees with the engine: the type, `hiddenInformation`, player bounds
(exactly the union of the engine's bounds over your option inputs), rules text for every exported
version, and the resource kinds.

The CPU budget (5 ms per call at the 99th percentile) is measured on the machine running the kit.
If a slow CI host fails a game that is within budget elsewhere, `games:verify --cpu-budget-ms <n>`
raises it there; don't raise it to hide a slow engine.

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
coverage, client code to 80 % lines.

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
- [ ] Errors are values with codes listed in `errorCodes`, none reserved; `validate` never throws
      for a schema-valid action.
- [ ] Records and `describe` text carry nothing hidden and nothing drawn; a decline says
      "declined", never "resigned".
- [ ] `test.optionInputs` lists the defaults and every option set that changes a rule, and
      `runKit(engines, { mode: "full", manifest })` reports no failures.
- [ ] Built relative imports name their files (`./rules.js`, not `./rules`), and the published
      files hold no `.ts`, `.tsx` or `.jsx` sources.
- [ ] dependency-cruiser and the engine ESLint config pass on the built output.
- [ ] Your rules tables pass, with coverage at 95 % for the engine and 80 % for the client.
- [ ] A changed rule or state shape is a new rules version, and the old one is still exported.
- [ ] Install instructions name your registry explicitly.
