# M1a review — resolutions

Picky review (P), security review (S) and the CI run (CI) of M1a, the SDK, the generic test kit and
the reference game (MR !5), round 1, with the owner's decision on each. One line per finding:
ID → outcome (where). Commits are on `m1a-sdk-kit`; spec changes stay in v0.9.8 (README history
line).

## CI

| ID | Outcome | Where |
|---|---|---|
| CI-1 | Fixed: the broken-fixture tests stop at their first failing game (`stopAtFirstFailure`), the CPU check stops timing as soon as the verdict is certain, and the new tests are sized for the slow runner; the kit's test file takes under 2 s locally (was 21 s on CI) | 18ac7f0 |

## Picky review (P)

| ID | Outcome | Where |
|---|---|---|
| P-1 | Fixed: half the games run with no seat leaving, and in the rest the exit chance is about 1 / `maxActions`; fixture: a game that never ends with `maxActions` 2000 | 18ac7f0, 02 §6.4 (10f773c) |
| P-2 | Fixed with S-3: the SDK's test hooks gain the required `optionInputs(ctx)` and optional `context()` and `resources(options)`; the kit and `games:verify` play them; a missing or empty `optionInputs` fails, so supplying only the defaults is impossible; fixture: a leak only under a non-default option | 18ac7f0, 02 §2, §6, §7.3 (10f773c) |
| P-3 | Fixed: `worstCase` fails when it is empty for a playable seat count, when a case's seat isn't in `toAct`, or when its action doesn't validate; the test that accepted an illegal worst case now asserts the failure | 18ac7f0, 02 §6.6 (10f773c) |
| P-4 | Fixed with S-4 and S-8: records are checked per role (Node and Worker inputs only from the engine + manifest set, web inputs from either), must contain the expected entry points (Node and Worker: every package's engine and manifest; web: every client entry behind `WEB_BUNDLES_GAME_CLIENTS`, set in M3), every installed package must be verified, `pnpm build` deletes `generated/bundles/` first; packed `.ts`/`.mts`/`.tsx`/`.jsx` sources and relative imports that don't name a `.js`/`.mjs` file are refused; `realpathSync.native`; only module inputs are covered (noted in code and spec) | 023d7a7, 02 §7.3, 10 M3 (10f773c) |
| P-5 | Fixed: an unacted seat declines only when at least `min` playing seats would remain, otherwise (and sometimes anyway) it resigns; only seats that have acted time out; the secrecy record check follows the same rule | 18ac7f0, 02 §6.5 (10f773c) |
| P-6 | Fixed: `maxActions` must be a positive safe integer of at most 1 000 000 | 18ac7f0, 02 §6.4 (10f773c) |
| P-7 | Fixed: at every step every seat in `toAct` has its `randomAction` validated; fixture: a multi-seat `toAct` with a seat that can't act | 18ac7f0, 02 §6.5 (10f773c) |
| P-8 | Fixed: non-vacuity counts a perturbation only if some other viewer's view (another seat's or the public one) changes; only a module whose perturbations never change any view is counted by the state diff | 18ac7f0, 02 §6.3 (10f773c) |
| P-9 | Fixed: 10 warm-up runs, 100 timed runs in fast mode (300 full), the slowest 1 % dropped so one pause can't fail a correct module; documented as measured on the host running the kit; `games:verify --cpu-budget-ms <n>` overrides, and an unusable budget fails | 18ac7f0, 023d7a7, 02 §6.6, 08 T25 (10f773c) |
| P-10 | Fixed: the example reshuffles the face-down discards into a deck too small to refill every hand, so transitions draw, replay covers per-transition draws, and records stay draw-free | 18ac7f0 |
| P-11 | Fixed: the example's tests use the testkit's `seededRandom`; its own generator is gone | 18ac7f0 |
| P-12 | Fixed: `Board` catches rejections from `preview` and `submit` and shows them in its alert region | 1523833 |
| P-13 | Fixed: in a workspace game every file reachable from an entry point must be one `pnpm pack` publishes | 023d7a7 |
| P-14 | Fixed: the manifest's `players` must equal the union of the engines' bounds over the option inputs | 18ac7f0 |
| P-15 | Fixed: `RESERVED_ERROR_CODES` is tested against the 05 §Errors table, parsed like the `docs/deploy.md` cross-check (in `scripts/src/ci`, since the SDK compiles without Node types) | ce8a294 |
| P-16 | Fixed with S-9: `Object.getPrototypeOf`, `Reflect.getPrototypeOf` and the `__lookupGetter__`/`__lookupSetter__`/`__defineGetter__`/`__defineSetter__` members are refused; F-5 names the residual of a user-defined `.map`-like function receiving `Number`/`String`/`Boolean` | 5b744ec |
| P-17 | Fixed: 02 §6 gives the counts (300 per rules version fast, 1000 per option input and seat count full); 11 §9 lists `games:check-inputs` in the build stage; 02 §6 and §7.3 say `games:verify` never runs in a deploy job; the guide's §3, §4 and §7 give the counts, `games:check-inputs` and the hooks; history line updated, v0.9.8 kept | 10f773c |
| P-18 | Fixed: an exception from `setup` or a transition is reported under `schema` | 18ac7f0, 02 §2.1 rule 3 (10f773c) |
| P-19 | Fixed: 02 §2.1 rule 3 says resolved options and preview results never have the shape `{ code, detail? }` | 10f773c |
| P-20 | Deferred (owner): 10 M3 says "`rng` stores `[max, value]` pairs so replay detects a changed draw range" | 10f773c |
| P-21 | Fixed in the docs (owner's choice): fast mode stays 300 games per rules version, and the spec, guide and code comments say so | 10f773c, 18ac7f0 |
| P-22 | Fixed: URL schemes are looked for only in URL contexts (`href`, `xlink:href`, inside `url(…)`), so `aria-label="Score: 5"` passes; CSS escapes and unclosed or quoted `url()` are refused | 5b744ec |

## Security review (S)

| ID | Outcome | Where |
|---|---|---|
| S-1 | Fixed: secrecy samples are spread uniformly over each game (reservoir sampling, checked after the game), and in full mode a tenth of the games are checked at every step; fixture: a leak only late in the game, which fails in fast mode | 18ac7f0, 02 §6.3 (10f773c) |
| S-2 | Fixed: two different legal actions by one seat on one state that leave every other view identical must give identical records and `describe` text; fixture: a record that repeats a secret choice; 02 §6.3 and the guide updated | 18ac7f0, 10f773c |
| S-3 | Fixed with P-2 | 18ac7f0, 10f773c |
| S-4 | Fixed with P-4: a server build reading a file checked only as client code fails | 023d7a7 |
| S-5 | Fixed: a global `!**/node_modules/` ignore pattern lifts ESLint's default (with `ignore: false`, as first attempted, the default stays in force), any file ESLint still ignores is a hard failure, and tests run `games:verify` on packages copied under a real `node_modules` and under `.git/` | 023d7a7 |
| S-6 | Fixed: outputs are compared as JSON with their key order; fixture: a view whose key order follows hidden state; noted in 02 §6.3 | 18ac7f0, 10f773c |
| S-7 | Accepted (owner) for this MR: F-8 and F-9 record that the first `@your-move/sdk`/`testkit` publish (0.1.0) precedes the M1 job-token and per-job environment checks; the M1 release-path work closes or records it | 10f773c |
| S-8 | Fixed with P-4 | 023d7a7 |
| S-9 | Fixed with P-16 | 5b744ec |
