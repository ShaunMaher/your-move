# Game module: `words`

The crossword-tile word game, and the first module on the game framework
([02-game-framework.md](../02-game-framework.md)). The framework handles accounts, lobby, turns,
timeouts, storage and secrecy plumbing; this document defines the rules and the module contract
implementation (§10).

Within the module, rules are **modular** too: a game is played under one *ruleset* and one *dictionary*, both chosen by the
player who creates the game (§8, §9) and fixed for the life of the game.

- The **engine** implements the shared crossword-tile mechanics below (placement, word finding,
  scoring, turns, end of game).
- A **ruleset** is a data file that sets every number and selects among a small set of *named
  behaviour variants* the engine supports (e.g. swap order). No ruleset contains code.
- A **dictionary** is a word list with metadata, selected independently of the ruleset, subject to
  compatibility (§9.3).

The MVP ships two rulesets modelled on the two best-known games (§8.3), and one dictionary
(ENABLE). Game *mechanics* aren't protected by copyright, but product names, logos, artwork and
trade dress are, so **rulesets carry neutral display names** and the app never uses the commercial
games' names (CLAUDE.md hard rule).

Wherever this document says "default", it means a ruleset field; the engine MUST read every value
from the ruleset, never from constants.

## 1. Components

- Board: `boardSize`² squares (15×15 in both MVP rulesets) with a designated start square.
- Premium squares: double letter (DL), triple letter (TL), double word (DW), triple word (TW).
- Tiles: per-ruleset distribution and point values, including blanks. Blanks are worth 0 and are
  assigned a letter when played; that assignment is permanent.
- Rack: `rackSize` tiles per player (7 in both MVP rulesets).
- Dictionary: chosen at game creation (§9).

## 2. Setup

1. The bag is shuffled with an unbiased Fisher–Yates shuffle (rejection sampling, no modulo bias).
   The engine is pure, so it never calls a random API itself: every engine function that needs
   randomness takes a required `rng: RandomSource` parameter (`nextInt(maxExclusive): number`).
   The server always passes the WebCrypto-backed source; tests pass a seeded deterministic source.
   There is no default value for the parameter.
2. Turn order = seat order, set by the framework's `seatOrder` (02 §4).
3. Each player draws `rackSize` tiles.

## 3. Turn actions

On their turn a player performs exactly one action.

### 3.1 Play tiles
Place 1..rackSize tiles from the rack onto empty squares such that:

1. Each placement targets a distinct, empty, in-bounds square (duplicates → `DUPLICATE_SQUARE`).
2. All placed tiles lie in a single row or a single column.
3. Together with existing tiles they form one contiguous line along that row/column (no gaps).
4. **Opening play** (the board is empty — regardless of how many passes/swaps preceded it): at
   least 2 tiles, and one MUST cover the start square.
5. Otherwise: at least one placed tile MUST be orthogonally adjacent to an existing tile.
6. Words formed: for a multi-tile play, the *main word* is the maximal run along the play line, and
   each *cross-word* is the maximal perpendicular run through a placed tile. For a **single-tile
   play** there is no play line: the words formed are the maximal horizontal run and the maximal
   vertical run through the tile. In all cases only runs of length ≥ 2 are words, at least one word
   MUST be formed, and every word formed MUST be in the dictionary.
7. Every blank placed MUST be assigned a letter; a `letter` field on a non-blank tile is rejected.

Tile codes are lower-case `a`–`z` and `?` for blank everywhere in data and APIs; the UI displays
upper case.

If any rule fails, the play is rejected with a specific error code (§10.3, carried as in
05 §Errors) and nothing changes.

### 3.2 Swap
Choose 1..rackSize tiles from the rack. Allowed only if the bag holds at least `swapMinBag` tiles.
Scores 0. Order of operations is the ruleset's `swapOrder` variant:

- `drawThenReturn` (the classic board-game rule): (1) draw the same number of replacement tiles
  from the top of the bag, (2) put the chosen tiles into the bag, (3) re-shuffle the whole bag. The
  player cannot redraw their own swapped tiles.
- `returnThenDraw`: (1) put the chosen tiles into the bag, (2) re-shuffle, (3) draw. The player may
  redraw some of them.

### 3.3 Pass
Scores 0.

### 3.4 Resign
The player forfeits. In a 2-player game (the only kind in v1) the game ends immediately; see §6.
Multi-player resignation semantics are deferred until 3–4 player games are specified.

## 4. Scoring a play

For each word formed (main word + each cross-word):

1. Sum letter values of all tiles in the word. For **newly placed** tiles only, apply DL (×2) or
   TL (×3) to that tile's value. Blanks are 0 regardless of letter premium.
2. Multiply the word total by the product of DW (×2) and TW (×3) multipliers on **newly placed**
   tiles in that word (they stack: two DWs = ×4, DW+TW = ×6).
3. Premiums under previously placed tiles are ignored.

Play score = sum of all word scores + `bingoBonus` if the player placed `rackSize` tiles in one
play.

There is no challenge phase in any ruleset: every word is checked against the game's dictionary at
submission, and invalid plays are rejected (the online convention).

After a play the player draws back up to `rackSize` (or as many as the bag holds).

## 5. Game end conditions

The game ends when any of the following happens:

1. **Out**: the bag is empty and a player plays their last rack tile.
2. **Scoreless streak**: `scorelessTurnLimit` consecutive scoreless turns across all players
   (e.g. 6 = three rounds in a 2-player game). Passes and swaps count; rejected attempts
   are not turns and do not count. A play scoring 0 (e.g. only blanks) counts as scoreless.
3. **Resignation**.
4. **Timeout**: the player to move has not acted within the game's turn timeout (a framework
   setting, default 14 days for this module; 02 §4). Treated as resignation by that player, except
   that a player who never acted takes no loss: the framework ends the game `declined` with no
   result (02 §4).
   Enforced **only by the periodic sweep** (03 §8, ≤ 15 min granularity); reads never write.
   This module's `onTimeout` is §10.6.

## 6. Final scoring

- **Out**: the player who went out adds the sum of all opponents' remaining rack tile values; each
  opponent subtracts their own remaining rack value.
- **Scoreless streak**: every player subtracts their own remaining rack value. No one gains.
- **Resignation / timeout**: scores are frozen; the resigning/timed-out player loses regardless of
  score. Record `endReason`.
- Winner = highest final score; equal scores are a draw (except resignation/timeout).

## 7. Information visibility

- A player sees: the board, all scores, move history, their own rack, the count of tiles in the
  bag, and the count (not identity) of each opponent's rack tiles.
- A player MUST NOT be able to obtain opponents' racks or bag contents/order through any API
  response, WebSocket message, push payload, or error message/shape. Error responses for invalid
  plays are computed only from the submitter's own rack and the public board.
- After the game ends, every player's final rack is revealed (`final.racks` in the view, §10.4). Bag order, the initial
  deal and per-move draws are **never** exposed, even after the game.
- The "tiles remaining" helper (unseen-tiles tracker: bag + opponents' racks combined) MAY be shown,
  because it is derivable from public information.

## 8. Rulesets

### 8.1 Data format

Each ruleset version is a data module at `games/words/src/engine/rulesets/<id>/v<N>.ts` that exports
one object literal in the shape below and nothing else (a TypeScript module rather than a `.json`
file, because built engine output may import only `.js` files, 02 §7.3). It is registered in
`games/words/src/engine/rulesets/index.ts`, which parses every registered version with the ruleset
schema when the engine loads, so an invalid ruleset fails the package's tests and `pnpm
games:verify` (build time). Both server and client bundle all rulesets (they are small), so the
client can render any game and preview any play.

```jsonc
{
  "id": "classic",                 // stable, neutral, never a trademark
  "version": 1,
  "name": "Classic",               // display name (neutral)
  "description": "The traditional board-game rules: 100 tiles, 50-point bonus for using all seven.",
  "language": "en",                // must match the dictionary's language (§9.3)
  "boardSize": 15,
  "start": [7, 7],
  "rackSize": 7,
  "bingoBonus": 50,
  "swapMinBag": 7,
  "swapOrder": "drawThenReturn",   // behaviour variant, see §3.2
  "scorelessTurnLimit": 6,
  "minPlayers": 2,
  "maxPlayers": 2,
  "tiles": { "a": { "count": 9, "points": 1 }, "...": {}, "?": { "count": 2, "points": 0 } },
  // premium squares as a boardSize-line picture, one char per square:
  // . = normal, d = DL, t = TL, D = DW, T = TW. The start square is given by "start" and may also
  // carry a premium letter (e.g. D).
  "premiums": [
    "T......T......T",
    "..............."
  ]
}
```

### 8.2 Rules for rulesets

- **Modularity boundary**: a ruleset may set any field above and pick among enumerated behaviour
  variants. A new kind of behaviour (e.g. a new premium type, power-ups, a different end condition)
  is added as an engine feature + a schema option + tests, and is then available to every ruleset.
  There is no plugin system or scripting.
- Every game stores `rulesetId` and `rulesetVersion`. A ruleset version is **immutable** once
  released; changes create a new version. All versions stay in the repo so old games keep working.
  New games always use the latest version of the chosen ruleset.
- Schema validation at build time: tile letters ⊆ `a`–`z` plus `?`; counts and points are
  non-negative integers; total tiles ≥ `rackSize × maxPlayers`; `premiums` has exactly `boardSize`
  rows of `boardSize` characters; `start` is in bounds. Also: `boardSize` ≤ 15 (the dictionaries'
  longest word, §9.1); `rackSize` ≤ `boardSize`; blanks are worth 0; `2 ≤ minPlayers ≤
  maxPlayers ≤ 2` (more seats wait until multi-player resignation is specified, §3.4); with
  `drawThenReturn`, `swapMinBag` ≥ `rackSize` (the replacements are drawn before the swapped
  tiles go back, §3.2). A dictionary letter has a tile only if its count is at least 1
  (§9.3).
- Each premium layout MUST be symmetric under 90° rotation (validated by a test).
- No two premium squares are orthogonally adjacent, the start square included (a DW start
  square never touches a DL), so premiums don't stack in one short word (checked by the
  schema).
- Word multipliers don't stack in short words either (checked by the schema; both reference
  boards meet these): two word-premium squares (DW, TW) in one row or column are at least 4
  squares apart, and the word premiums a word of up to 7 letters can cover multiply to at most
  ×4 (so no TW+DW, two TWs or three DWs within a rack's reach: no ×6, ×8, ×9 or ×12 below 8
  letters).
- The layout gives the first player nothing beyond the start square (checked by the schema; the
  traditional reference board meets it): a word through the start square of up to `rackSize`
  letters, along its row or column, covers word premiums multiplying to at most the start
  square's own word multiplier, and never more than ×2. So a DW start square allows ×2, and a
  start square with no word premium (none, DL or TL) allows ×1; a TW start square is invalid.
- Premium layouts are **original arrangements** designed by us, keeping the reference game's
  premium counts and overall density so the game feels familiar. They MUST NOT copy any commercial
  board square-for-square (see open question Q15). The coding agent documents the counts in the
  ruleset file.
- Operators can restrict which rulesets are offered for new games (`GAMES_WORDS_ENABLED_RULESETS`,
  09 §1);
  disabled rulesets still work for existing games.

### 8.3 MVP rulesets

Display names "Classic" and "Casual" (Q16) live only in the ruleset files.

| Field | `classic` — "Classic" | `casual` — "Casual" |
|---|---|---|
| Modelled on | the traditional board game | the popular mobile game |
| Board | 15×15, start (7,7) | 15×15, start (7,7) |
| Start square premium | DW | none |
| Premium counts (original layout) | 8 TW · 17 DW (incl. start) · 12 TL · 24 DL | 8 TW · 12 DW · 16 TL · 24 DL (approximately the reference game's counts) |
| Tiles | 100 incl. 2 blanks (table A) | 104 incl. 2 blanks (table B) |
| Rack | 7 | 7 |
| Bingo bonus | 50 | 35 |
| `swapOrder` | `drawThenReturn` | `returnThenDraw` (Q17) |
| `swapMinBag` | 7 | 7 (Q17) |
| `scorelessTurnLimit` | 6 | 6 (Q17) |

Beyond §8.2, neither MVP layout is symmetric under a mirror (the reference boards are), and each
has at most 12 pairs of premium squares one square apart in a row or column (`X.X`; the reference
boards have 8), so premiums don't cluster; tests check both.

**Table A — `classic` tiles (100)**

| Letter | Count | Points | | Letter | Count | Points |
|---|---|---|---|---|---|---|
| A | 9 | 1 | | N | 6 | 1 |
| B | 2 | 3 | | O | 8 | 1 |
| C | 2 | 3 | | P | 2 | 3 |
| D | 4 | 2 | | Q | 1 | 10 |
| E | 12 | 1 | | R | 6 | 1 |
| F | 2 | 4 | | S | 4 | 1 |
| G | 3 | 2 | | T | 6 | 1 |
| H | 2 | 4 | | U | 4 | 1 |
| I | 9 | 1 | | V | 2 | 4 |
| J | 1 | 8 | | W | 2 | 4 |
| K | 1 | 5 | | X | 1 | 8 |
| L | 4 | 1 | | Y | 2 | 4 |
| M | 2 | 3 | | Z | 1 | 10 |
| blank | 2 | 0 | | **Total** | **100** | |

**Table B — `casual` tiles (104)**

| Letter | Count | Points | | Letter | Count | Points |
|---|---|---|---|---|---|---|
| A | 9 | 1 | | N | 5 | 2 |
| B | 2 | 4 | | O | 8 | 1 |
| C | 2 | 4 | | P | 2 | 4 |
| D | 5 | 2 | | Q | 1 | 10 |
| E | 13 | 1 | | R | 6 | 1 |
| F | 2 | 4 | | S | 5 | 1 |
| G | 3 | 3 | | T | 7 | 1 |
| H | 4 | 3 | | U | 4 | 2 |
| I | 8 | 1 | | V | 2 | 5 |
| J | 1 | 10 | | W | 2 | 4 |
| K | 1 | 5 | | X | 1 | 8 |
| L | 4 | 2 | | Y | 2 | 3 |
| M | 2 | 4 | | Z | 1 | 10 |
| blank | 2 | 0 | | **Total** | **104** | |

Tests assert each table's totals (100 / 104) and that the ruleset files match these tables exactly.

Our own variants (different boards, tile tweaks, new mechanics) are added later as further
rulesets.

## 9. Dictionaries

### 9.1 Registry and data

- Each dictionary lives in `packages/dictionary/dictionaries/<id>/`:
  - `meta.json`: `{ id, version, name, description, language, licence, sourceUrl, sha256 }`,
    where `sha256` is the hash of `source.txt`
  - `source.txt`: the upstream list, unmodified, checked against `sha256` at build time
  - `additions.txt`, `removals.txt`: our edits, applied at build time: one word per line, sorted,
    no duplicates or comments; an addition must not already be in the source and a removal must be
    in it. Any change to the source or the edits is a new `version`.
- Build output per dictionary (`packages/dictionary/generated/<id>/`, never committed): sorted,
  newline-delimited, lower-case `a`–`z` words of length 2..15 (`words.txt`), plus brotli/gzip
  versions for the client, and a manifest (the `meta.json` fields, `sha256` still the source's
  hash, plus `wordCount`, `alphabet`, `wordsSha256` and `bytes` of `words.txt`, and how many
  upstream lines were dropped). The server checks `words.txt` against `bytes` and `wordsSha256`
  once per load, before first use. The build's index also carries the global removals, for the
  upload and operator paths (§9.5). Upstream lines with any character outside `a`–`z` are
  dropped, never lower-cased (they are proper nouns or abbreviations). Longer words can't fit
  any MVP board and are dropped. The word-length cap (15) and the ruleset schema's `boardSize`
  cap (§8.2) are one limit: raising it means raising both together, and a test ties the two.
- **Licensing gate**: only public-domain or permissively licensed lists may be added, with the
  licence recorded in `meta.json` and `packages/dictionary/README.md`. The official tournament
  lists (the North American NWL/TWL family and the Commonwealth Collins list) are **not** freely
  licensed and MUST NOT be added to the repo or bundled in builds. Players who have access to
  them can bring their own (§9.5).
- `removals.txt` ships with a list of slurs so they can't be played (Q7). The same words are also
  kept in a shared `packages/dictionary/removals-global.txt`, which is applied to every operator
  and uploaded dictionary (§9.5) and, as a safeguard, to the built-in ones too; a test checks that
  each built-in `removals.txt` contains every global removal present in that dictionary's
  source (a removal must be in the source, so one the source lacks isn't listed).

### 9.2 MVP dictionary

`enable` — ENABLE (Enhanced North American Benchmark LExicon), public domain, ~173k words,
language `en`. It's the only entry in the MVP, but the selection UI and data model treat
dictionaries as a list from day one, so adding one is a data change plus a build.

### 9.3 Selection and compatibility

- The game creator picks a dictionary when creating the game. The default is the creator's last
  choice (`users.settings.lastOptions.words`), then the instance default
  (`GAMES_WORDS_DEFAULT_DICTIONARY`).
- A dictionary is **compatible** with a ruleset when their `language` values match and every
  letter used by the dictionary's words has a tile in the ruleset. The build computes each
  dictionary's alphabet and stores it in its manifest. The UI offers only compatible pairs, and the
  server rejects incompatible ones (`400 INCOMPATIBLE_DICTIONARY`).
- Operators can restrict the built-in dictionaries offered for new games (`DICTIONARIES_ENABLED`,
  framework resource config, 09 §1).
  A dictionary used by any non-finished game MUST NOT be removed from a deployment; disabling only
  hides it from new games.

### 9.4 Versions and lookup

- Each game records the dictionary id and the version it started with (in `options`, and in the
  framework's `game_resources` table, 04). Only the **current** build of each dictionary is
  deployed, and it applies to every game using that dictionary, including games in progress. The recorded version is informational only. Changes to
  additions/removals bump the version.
- The server is authoritative. The client downloads the game's dictionary by versioned, hashed URL
  from the game envelope's `resources[].downloadUrl` (05), so it works even after the dictionary is
  disabled for new games, caches it (07 §4), and uses it only for local, non-authoritative checks:
  the no-play hint (§10.8) and, as a follow-up, instant validity previews. The catalog (§10.1), which the new-game screen uses to choose a
  dictionary, carries no download URL: nothing is previewed before a game exists.
- Server lookup is a binary search directly over the sorted text. No index is built, so loading
  costs only I/O and no request pays a parse cost (Workers Free: 10 ms CPU/request). Dictionaries are
  loaded lazily per id and cached per isolate/process. On Cloudflare they're fetched once per
  isolate from the static-assets binding, from the same versioned, hashed files clients download
  (since alpha A2; bundling them as text modules was the first plan). See 03 §10.

### 9.5 Bring-your-own dictionaries

The official tournament word lists can't be bundled (§9.1), but players who have legitimate access to
one can use it. There are two routes, and both go through the same **server-only** pipeline:

| | Operator dictionaries | Uploaded dictionaries |
|---|---|---|
| Who adds it | The person running the instance, e.g. under their own NASPA licence | Any signed-in player whose account is at least 7 days old or has finished a game (Q18) |
| How | `pnpm admin:dict:add` (09 §1) and listed in `DICTIONARIES_EXTRA` | Uploaded from Settings → Word lists (off with `DICTIONARY_UPLOADS=false`) |
| Who can choose it for new games | Everyone on the instance | Only the uploader — enforced by the framework's resource authorisation at create time (02 §2.1 rule 7); anyone else gets `400 INVALID_OPTIONS` with `detail.code = UNKNOWN_DICTIONARY`, exactly as for an id that doesn't exist |
| Who plays with it | Everyone in games that use it | Everyone in games the uploader creates with it |

**Distribution classes.** Each dictionary has `distribution: "public" | "serverOnly"`:

- `public`: built-in, freely licensed lists such as ENABLE. Clients download the list for instant
  previews (§9.4).
- `serverOnly`: every operator and uploaded dictionary. **The word list is never sent to any client,
  the uploader included.** The client engine runs placement and scoring locally, and gets validity
  from the server's preview endpoint (05), which takes the full module `play` action only — there is
  no free-form "check these words" endpoint. So the operator never redistributes the list, only
  answers for plays made from the player's own rack on the real board, as every online word game
  does.
- **Oracle limits.** `validate` and `preview` run every structural and rack check (§10.3) before any
  dictionary lookup, so a play using tiles not in the rack never reaches the word list. Lookups
  against `serverOnly` lists are rate-limited per word looked up (08 §4), separately from the
  general preview limit; the framework reserves `placements + 1` lookups before calling the module
  and aborts with `429` if the module would exceed them (03 §10), so crossing the limit never yields
  an `INVALID_WORDS` answer.

**Upload format and processing.**

- Plain text, UTF-8, one word per line. Blank lines and lines starting with `#` are ignored. Case is
  ignored. Only `a`–`z` are allowed. Words of length 2..15 are kept and the rest are skipped and
  counted.
- The browser normalises, deduplicates, sorts and gzips the file (`CompressionStream`) before
  uploading, so the server does only a single linear validation pass: strictly sorted, valid
  characters and lengths. It also computes the word count, the alphabet and a SHA-256 hash.
- Limits: ≤ 8 MB compressed and ≤ 16 MB decompressed (the decompression cap is enforced while
  streaming, to stop zip bombs), ≤ 500,000 words, ≤ 5 uploads per user per day. The per-user quota
  (3 lists, 24 MB) counts every upload whose blob hasn't been purged yet, deleted or not. An
  instance-wide total (`LIMIT_DICT_TOTAL_BYTES`) and daily upload cap apply; when exceeded, uploads
  are refused and an alert is logged (08 §4).
- Storage: the blob is streamed to a temporary, server-generated key (UUID), validated, then the
  `dictionaries` row is inserted pointing at it. The sweep deletes blobs with no row that are older
  than 1 hour (failed or aborted uploads). Keys are never derived from user input, and identical
  lists uploaded by different users are stored separately (no cross-user dedup, which would reveal
  that a list already exists).
- The removals policy (Q7) applies to uploads and operator lists too: the server drops every word
  in `packages/dictionary/removals-global.txt` (§9.1) while validating, so they can't be played or
  appear in history or notifications.
- Before uploading, the user gives a name (same rules as display names, 06 §5, since opponents see
  it), picks a language (default `en`), and ticks: *"I have the right to use this word list."*
- Uploaded dictionaries are immutable. "Replace" means upload a new one and delete the old one.

**Lifecycle.**

- Ids: built-in dictionaries use their registry id (`enable`). Uploads get `u_<uuid>`. Operator
  dictionaries use the operator's chosen id, which must match `^[a-z][a-z0-9-]{1,31}$`, must not
  start with `u_` and must not collide with a registry id.
- When the owner deletes an upload, it disappears from their picker straight away. The stored file
  is purged by the sweep once no `lobby` or `active` game references it. Until then, those games
  keep working.
- Account deletion does the same for all of the user's uploads. Their active games are resigned
  anyway (04 §Account deletion).
- Finished games keep only the dictionary's name.
- Opponents see the word list's name and the label "uploaded by <creator>" on the game invitation
  and in the game's info sheet, and can decline the game if they don't want to play with it.

**Where to get a list.** The in-app help page (07 §1) explains this neutrally and links only to
official sources:

- *NASPA Word List* (North America): available to NASPA members as a plain-text download through
  NASPA Member Services; NASPA also offers free noncommercial licences.
- *Collins Scrabble Words* (most other countries): published by HarperCollins; included in the
  *Collins Zyzzyva* study app; see WESPA for details.
- A note: "Check the licence terms of any list you upload. We don't provide these lists."

The page never links to unofficial copies.

## 10. Module contract implementation

### 10.1 Options, players, resources, catalog

```ts
Input   = { rulesetId?: string; dictionaryId?: string }
Options = { rulesetId: string; rulesetVersion: number; dictionaryId: string; dictionaryVersion: number }
```

- **Module config** (`configSchema`, 09 §1): `GAMES_WORDS_ENABLED_RULESETS`,
  `GAMES_WORDS_DEFAULT_RULESET`, `GAMES_WORDS_DEFAULT_DICTIONARY`. Which dictionaries exist, are
  enabled or may be uploaded is framework resource config (`DICTIONARIES_*`, 02 §2.1 rule 7); the
  module sees only the resulting `ctx.resources`.
- `resolveOptions(input, ctx)`: fills missing fields from the instance defaults (the framework has
  already merged the creator's last choices, 05); unknown or disabled ruleset → `UNKNOWN_RULESET`;
  a dictionary not in `ctx.resources` (unknown, disabled, deleted, or someone else's upload) →
  `UNKNOWN_DICTIONARY`; incompatible pair (language/alphabet from the resource metadata) →
  `INCOMPATIBLE_DICTIONARY` (§9.3). Resolves the latest ruleset version and the dictionary's
  current version.
- `catalog(ctx)`: enabled rulesets (id, version, name, description, key numbers, premium preview),
  the dictionaries in `ctx.resources` with their compatibility per ruleset, and the defaults.
- `players(options)` = `{ min: ruleset.minPlayers, max: ruleset.maxPlayers }` (2/2 in the MVP).
- `validateStart(options, seats)`: total tiles ≥ `rackSize × seats`, else `NOT_ENOUGH_TILES`.
- `defaultTurnTimeoutDays` = 14.
- `resources(options)` = `[{ kind: "dictionary", id: options.dictionaryId, version: options.dictionaryVersion }]`.

### 10.2 State (secret, server-only)

`{ options, board, bag, racks[seat], scores[seat], turn, scorelessStreak, lastMove,
finished: null | { reason, adjustments[seat], leaver } }`, where `options` holds the ruleset and
dictionary ids and versions, `lastMove` is the record of the last transition (§10.4) and `leaver`
is the seat that resigned, timed out or declined (null for `out` and `scoreless`). The bag order
and other players' racks are hidden information for `perturbHidden`.

### 10.3 Actions

```ts
Action =
  | { type: "play", placements: { row: number, col: number, tile: string /* "a".."z" | "?" */, letter?: string /* required for "?" only */ }[] }
  | { type: "swap", tiles: string[] }
  | { type: "pass" }
```

(Resign is a framework action that calls `onResign`.) `errorCodes`: `INVALID_PLACEMENT`
(`detail`: `NOT_IN_LINE` · `GAP` · `NOT_CONNECTED` · `START_NOT_COVERED` · `SQUARE_OCCUPIED` ·
`OUT_OF_BOUNDS` · `DUPLICATE_SQUARE` · `TILE_NOT_IN_RACK` · `BLANK_NEEDS_LETTER` ·
`LETTER_ON_NON_BLANK` · `TOO_FEW_TILES` · `NO_WORD_FORMED` · `TOO_MANY_TILES`), `INVALID_WORDS`
(`detail: { words: string[] }`: each word not in the dictionary once, in the order formed),
`SWAP_NOT_ALLOWED` (`detail`: `BAG_TOO_SMALL` · `TILE_NOT_IN_RACK`), `NOT_TO_ACT` (`validate` or
`preview` for a seat that isn't in `toAct`, which the framework never asks), plus
`UNKNOWN_RULESET`, `UNKNOWN_DICTIONARY`, `INCOMPATIBLE_DICTIONARY`, `NOT_ENOUGH_TILES`
(`detail: { needed, tiles }`: `rackSize × seats` and the ruleset's tile count),
`OPTIONS_NOT_OBJECT` and `UNKNOWN_OPTION` from option resolution, `checkConfig` (with `detail: {
key }` naming the config key, never its value) and start. `UNKNOWN_OPTION` has `detail: { option
}` naming the unknown key only when the key matches `^[A-Za-z0-9_]{1,64}$`, and no `detail`
otherwise, so arbitrary input is never echoed.

Placements are taken in board order (by row, then column) whatever order they were sent in, so
answers and records never depend on it; cross-words follow the main word in that order.

**Check order** (first failure wins): every `INVALID_PLACEMENT` check, rack checks included, runs
before any dictionary lookup, in the order `TOO_MANY_TILES`, `OUT_OF_BOUNDS`, `DUPLICATE_SQUARE`,
`SQUARE_OCCUPIED`, `BLANK_NEEDS_LETTER`/`LETTER_ON_NON_BLANK`, `TILE_NOT_IN_RACK`, `NOT_IN_LINE`,
`GAP`, then `TOO_FEW_TILES` and `START_NOT_COVERED` for the opening play or `NOT_CONNECTED` for a
later one, and `NO_WORD_FORMED`; `INVALID_WORDS` comes last. Errors are computed only from the
submitter's rack and the public board (secrecy contract), and the kit's `randomAnyAction` exercises
off-rack plays to prove `INVALID_WORDS` is never returned for them.

### 10.4 View

```ts
View = {
  ruleset: { id, version }, dictionary: { id, version },   // name/distribution come from the envelope's resources (05)
  board: (null | { tile: string, letter: string, blank: boolean })[][],
  scores: number[], rackCounts: number[], bagCount: number,   // scores: final scores once finished
  yourRack: string[] | null,                  // the viewer's only, sorted; null in the public view
  lastMove: WordsRecord | null,               // the last transition's record
  final?: { reason: "out" | "scoreless" | "resign" | "timeout" | "decline", adjustments: number[], racks: string[][] }  // only once finished
}
WordsRecord =                                   // discriminated by type
  | { seat, type: "play", placements: { row, col, tile, letter }[],   // 1+, in board order
      words: { word: string, score: number }[], score: number, bingo: boolean }  // 1+, main word first
  | { seat, type: "swap", swapCount: number, score: 0, bingo: false }  // swapCount ≥ 1; never which tiles
  | { seat, type: "pass" | "resign" | "timeout" | "decline", score: 0, bingo: false }
```

Racks (`yourRack`, `final.racks`) are shown sorted (`a`–`z`, then blanks), so no view shows the
order tiles were drawn in (§7). `lastMove` makes every public move visible in the view: a swap
and a pass, or two swaps of different sizes, otherwise leave every other viewer's view the same,
and the kit requires their different records to show up in a view (02 §6.3).

### 10.5 Preview

`preview(state, seat, { type: "play", ... })` → `{ score, words: [{ word, score }], bingo }` or a
`GameError`, with the same check order as `validate`. The client computes previews locally when the
game's dictionary is `public` and loaded; otherwise it calls the server preview endpoint (05),
debounced (§9.5).

### 10.6 Resign, timeout, result

- `onResign` / `onTimeout` (2-player): the game ends; the other player wins regardless of score
  (§6). Record type `resign` / `timeout`. `seatStatus` reports the resigning/timed-out seat `out`.
  (A decline or timeout before a player's first action never reaches the module in a 2-player game:
  the framework ends it `declined`, 02 §4. If `reason` is `"decline"` — only possible once 3–4
  player games exist — the record type is `decline` and `describe` says the player declined, never
  that they resigned, 02 §2.1 rule 9.)
- `result()`: ranking by final score (ties share rank) for `out` / `scoreless` endings; the
  non-resigning player ranks 1 for `resign` / `timeout`.
- `summary()`: `{ headline: [{seat:0}, " 212 – 187 ", {seat:1}], scores }`, rendered as
  "You 212 – 187 Sam"; `describe()`: `[{seat:1}, " played QUIZ for 64"]`, naming the main word of
  a multi-tile play, and for a single tile (which has no play line) the longest word it formed,
  the higher-scoring one on a tie, then the across word; a bingo adds ", using every tile".
- `test.maxActions`: bounded by the scoreless-streak rule. Every play puts at least one tile on
  the board for good, so there are at most `P = min(total tiles, boardSize²)` plays, at most
  `scorelessTurnLimit − 1` passes and swaps in a row around each of them, and one exit:
  `P + (P + 1)(scorelessTurnLimit − 1) + 1` (606 for `classic`, 630 for `casual`).
- `test.worstCase`: full-rack plays on crowded boards with many cross-words: a seven-tile play
  between two seven-letter words, forming the main word and seven cross-words, with and without a
  blank; a seven-tile play into the gaps of a 15-letter word, the longest word and lookup there is;
  and a swap of the whole rack (which shuffles the whole bag).
- `test.context` and `test.resources`: an engine can't load a word list (02 §2), so the kit plays
  with a **kit word list** carried in the engine: every two- and three-letter word of the built
  `enable` list plus the longer `enable` words the worst cases need (about 1,070 words; its test
  generates it from the built list and fails if it differs). It ships in the engine with the other
  test hooks (02 §6), but only `test.resources` turns it into a lookup set, so loading the engine
  never builds it. The package's own tests also play the kit, and thousands
  of property-test games per ruleset, against the full built `enable` list.
- Rulesets allow exactly two seats (§8.2), so every resignation, timeout or decline ends the game.
  A game with more seats is a precondition failure (the engine throws, 02 §2.1 rule 3) until
  multi-player resignation is specified (§3.4); so is `onResign`/`onTimeout` on a finished game,
  which the framework never calls.

### 10.7 Module-specific tests

In addition to the framework test kit: rule tables for every rule in §3–§6, both `swapOrder`
variants, each MVP ruleset's tile table and premium counts, and tile conservation
(bag + racks + board = ruleset multiset) on every state produced by random play.

### 10.8 No-play hint (client)

On their turn, the board tells a player whose rack has no legal play (alpha A14), so they swap or
pass instead of hunting for a word that isn't there.

- **Client only, from what the viewer may see.** The search runs in the browser on the viewer's
  view (the public board and `yourRack`) and the game's `public` word list, which the shell hands
  the board as `resources.dictionary` (02 §3, 07 §4) and the board uses only when its id is the
  view's dictionary id. Words are lower-case `a`–`z` only (§9.1), which is all `follows`
  answers; the shell hands over only a list that passes the word-list check, and a board must
  treat any other as no list. It never uses another seat's rack, the bag or a `serverOnly` list, sends
  nothing, and needs no server, API or view change. Until the list is loaded, or when there is
  none, the board says nothing.
- **Sound, never a false "no".** The search (`moves.ts` in the engine, pure and deterministic)
  is exhaustive: anchor squares (the start square on an empty board), cross-checks for the words
  formed across the play line, a prefix walk of the sorted list, every letter for a blank, and
  the ruleset's board, rack size and opening rules (§3.1). Two-tile plays are tried everywhere
  first, then every length. A play it finds is confirmed with the engine's own placement rules
  (`analysePlay`) and the list. Its work is counted in steps (search nodes and list questions),
  never timed; past `HINT_MAX_STEPS` (150,000, measured in `moves.benchmark.test.ts` over the list
  as the client holds it) it gives up and the board says nothing. Only a finished search that
  found nothing shows the hint. The search keeps its place on an explicit stack, so a slice stops
  within `MAX_STEPS_PER_ACTION` (3) steps of its budget wherever it is, never only between
  anchors.
- **When it runs.** Only on the player's turn in an active game, once per game version and rack
  (the answer is kept for them), in slices of 5,000 steps that yield to the browser between them.
  While a tile is pressed or dragged no slice runs; the search waits and goes on after it is
  let go. A new
  version or rack stops the search under way, and nothing it would have said is shown. Off turn
  nothing runs.
- **In every game, for every player** (A14-S-4). The hint is not an AI assist and is on whatever
  the game's `aiAssistance` (02 §9.3): every player gets the same hint, and it is derived only
  from public data (the board, the bag count, the public list) and the viewer's own rack, which
  that player could search by hand. It never shows a play: the client keeps only whether a play
  exists, never the play the search found. The rules text says so.
- **What it says.** In the status line, in place of "Place tiles to make a word." while no tiles
  are on the board: "No word can be played with your tiles. Try swapping some." when the bag holds
  at least `swapMinBag` tiles (§3.2), else "No word can be played with your tiles. You can pass."
  The status line's live region announces it when it appears. It is a hint only: Play, Swap and
  Pass work as before, and nothing is done for the player.
- **Tests.** Rule tables; a property test on a small board where a brute-force enumerator asks
  `analysePlay` about every placement and must agree ("none" exactly when it finds nothing);
  every play found in random games under each ruleset passes `validate` with the real list; a
  benchmark on mid- and late-game boards with 0, 1 and 2 blanks that checks steps and records
  time (as test annotations, never asserted); a test that no slice overshoots its budget by more
  than one action; Board tests for each answer, a drag, a new version or rack mid-search and an
  unmount mid-search; shell tests that the list is handed over only when public, intact, a word
  list and loaded, as one object per list; and a Playwright check that a real game shows the hint (the
  rack in the viewer's own copy of the view rewritten to one that forms no word).
