# Game module: `pairs`

The traditional memory game for 2–6 players, for families (younger players included, playing
through a parent's account, Q20): a grid of cards lies face down, each face on exactly two cards.
On your turn you turn over two cards. If they match, you keep the pair and go again; if not, they
turn back face down and the next player goes. When every pair is found, the player with the most
pairs wins.

The game itself is traditional and public domain. Commercial editions and a television show have
used names for it (lineage only: "Memory", "Concentration"); the module, its UI, its rules text and
its assets never use them.
**"Pairs" is a working name** (placeholder, like "Paths"): a published card game already has that
title, so the final name is the owner's legal call (Q32). The UI describes the game in plain words
("turn over cards to find the pairs"), and its card faces and card back are our own artwork.

**The design problem.** Played asynchronously, the game loses its point if anything shows every card
turned: anyone could scroll back. So a card's face reaches players only through `view`, and only
while the card is face up (§4). Records name no card at all, and never a face or whether a pair
matched (02 §2.1 rule 5, Q31). The design comes from the owner's note in 10 §Later; this document
settles it.

## 1. Components

- **Grid**: `columns × rows` cards, chosen by the `grid` option (§7). Card `(row, column)`: row from
  the top, column from the left, both from 0. Its **card index** is `row × columns + column`
  (reading order); the state stores cards in that order.

  | `grid` | Columns | Rows | Cards | Pairs | Move limit (§6) |
  |---|---|---|---|---|---|
  | `4x4` | 4 | 4 | 16 | 8 | 256 |
  | `4x5` (default) | 4 | 5 | 20 | 10 | 400 |
  | `5x6` | 5 | 6 | 30 | 15 | 900 |
  | `6x6` | 6 | 6 | 36 | 18 | 1,296 |

  Grids are written columns × rows. No grid is wider than 6 columns, because 6 is the most that
  fit a 320 px screen with 44 CSS px cards (§9).
- **Faces**: 18 faces, ids 0–17, our own simple drawings. A game uses `pairs` of them, each on
  exactly two cards. Each face is told apart by its **shape**; colour is decoration and never needed
  to tell two faces apart (colour-blind safe). Every face has a name, used in accessible names and
  status text:

  | Id | Name | Plural | Id | Name | Plural |
  |---|---|---|---|---|---|
  | 0 | acorn | acorns | 9 | key | keys |
  | 1 | apple | apples | 10 | kite | kites |
  | 2 | bell | bells | 11 | leaf | leaves |
  | 3 | boat | boats | 12 | moon | moons |
  | 4 | cat | cats | 13 | snail | snails |
  | 5 | cloud | clouds | 14 | star | stars |
  | 6 | fish | fish | 15 | sun | suns |
  | 7 | flower | flowers | 16 | tree | trees |
  | 8 | house | houses | 17 | umbrella | umbrellas |

  The ids and what each one depicts are part of the rules version; the drawing style may change
  in any release. No face may resemble a brand mark: the apple is whole, with a leaf and no bite
  taken out of it, and no face is a stylised bird.
- **Card back**: one original pattern, the same for every card, unlike any commercial edition's.
- **Card states**: `down` (face down), `up` (the first card of the turn in progress), `missed`
  (the previous turn's unmatched pair, shown until the next first card is turned, §4) and `matched`
  (found, face up for the rest of the game). `missed` cards are face down for the rules: they are
  shown, not out of play.
- **Player number**: seat + 1 (1–6), shown beside each player's name and on the cards they matched
  or missed (§9).

## 2. Setup

1. Turn order = seat order (the framework's `seatOrder`, 02 §4); seat 0 turns first.
2. **Faces in play**: the 18 face ids are always shuffled with the `rng` (so every grid draws the
   same way) and the first `pairs` are kept. Which faces are in play is public (the view lists
   them, §8.4); where they lie is not.
3. **Layout**: the deck is the faces in play in ascending order, each twice (`[a, a, b, b, …]`),
   shuffled with the `rng` (the SDK's `shuffle`) into card-index order. The layout is secret
   state: no card's face reaches any seat until the card is turned (§4).

## 3. A turn

A turn is two actions, each its own transition (02 §2.3): turn a first card, then, having seen it,
a second.

1. **First card**: the player to act turns over any card not `matched` (a `missed` card included).
   It is now `up`, and the previous turn's `missed` pair, if any, goes face down (§4). The player
   stays in `toAct`.
2. **Second card**: the player turns over any other card not `matched`.
   - **A match** (same face): both cards are `matched` and the pair is the player's. If it was the
     last pair, the game ends (§6); otherwise the same player takes another turn.
   - **No match**: both cards become the `missed` pair, shown to every seat until the next first
     card is turned. The turn passes to the next seat in turn order that is still playing
     (wrapping round).
3. Each accepted card restarts the player's clock (02 §2.3), so a turn that finds pairs may last
   longer than one turn timeout; each card is progress, and the move limit (§6) ends every game.

A card's face is never known to the client before the server answers: the board shows it from the
view that the submit returns (§9).

## 4. What each player sees

This is the core of the design. While the game is in progress, **every seat and the public get the
same view**, and it shows a card's face exactly when:

| Card | Face in the view |
|---|---|
| `matched` | shown, with the seat that found it |
| `up` (the first card of the turn in progress) | shown, with the seat to act |
| `missed` (the previous turn's unmatched pair) | shown, with the seat whose turn it was, **until the next first card is turned** |
| every other card | hidden (`null`), including cards that were face up earlier and turned back |

- The `missed` pair is cleared by the next first card turned in the game, whoever turns it.
  Normally that is the next seat. If that seat leaves before turning a card (§5), the pair stays
  shown for the seat that then has the turn.
- Once cleared, those faces are gone from every view, and nothing else serves them: records and
  their `describe` text name no card (§8.5), so the history drawer and notifications can't help
  anyone remember either, and a finished game displays from `final_views` (02 §5). **Remembering
  them is the game.**
- With 3 or more seats, only the next seat is sure to see a `missed` pair; the others see it only
  if they look before that seat's first card (accepted, design note).
- Once the game is over (`endReason` set), the view shows every card's face, so a game that ended
  with cards still down (§6) shows where the rest were.

What the history does tell: who turned a first or a second card, and so, from who turned next,
whether a turn matched, which the view's matched cards show anyway. It never says which cards were
turned (Q31: with positions, the history alone could solve a late game).

Screenshots, notes and any client that polls the view (a script, or an assistant reading views
with a `read` token, which 02 §9.3 always allows) remember for their player. That defeats the game
for that player, can't be seen by the others, and is accepted for a family game played among
friends (F-27); the rules text says so (§8.7).

## 5. Leaving the game

- **Resign** (any time), **timeout** (a seat that has acted, 02 §4) and **decline** (a seat
  before its first card, when enough seats remain; otherwise the framework ends the game itself,
  02 §4) all do the same to the game: the seat is out, and its pairs stay face up and keep counting
  as its own (shown in the view and as its score). A decline's record and text say the player
  declined, never that they resigned (02 §2.1 rule 9).
- **Mid-turn** (the seat to act leaves with its first card `up`): that card turns back face down.
  The `missed` pair was already cleared by that card, so no card is shown.
- **The seat to act leaves before its first card**: a `missed` pair still shown stays shown, for
  the seat that now has the turn (§4).
- If it was the leaver's turn, the turn passes to the next seat still playing, as after a miss;
  otherwise the seat to act keeps the turn.
- If only one seat is still playing, the game ends (`last-standing`, §6). In a 2-player game every
  resignation or timeout does this. A leave by the seat to act can also end the game at the move
  limit (§6).

## 6. End of game

- **All pairs found** (`all-found`): the seats still playing rank by pairs found, most first,
  ties sharing a rank (standard competition ranking, 02 §4). Seats that left (resigned, timed out
  or declined) rank below every seat still playing, whatever their pairs, the most recent leaver
  highest (one seat leaves per transition, so they never tie). The framework then drops declined
  seats from the ranking and re-ranks the rest (02 §4).
- **Last standing** (`last-standing`): the one seat still playing ranks 1; the others rank by when
  they left, the most recent highest. Cards still down stay down.
- **Move limit** (`move-limit`): after every second card, and after every leave by the seat to act,
  the game ends if `moves ≥ 4 × pairs²` (`moves` counts every card turned and every leave). The
  limit grows with the square of the pairs, as play without memory does: players turning cards at
  random find all the pairs within it in at least 98 % of games on every grid (98.4 % at `4x4`,
  99.9 % at `6x6`, simulating 4,000 games each), so a real game, where players remember something,
  almost never meets it; a linear limit (16 × pairs) would cut off a fifth to two-fifths of weak-memory games on `5x6`
  and `6x6`. It ranks exactly as `all-found`. As game design: the limit is shown as it nears ("N moves left", §9), so it never
  ends a game by surprise, and a player who is ahead can't run it down alone: a turn that finds no
  pair uses two moves and passes the turn, and the others go on finding pairs on theirs. The limit is what makes the game's length follow from its rules (02 §6.4), and it
  bounds a game that colluding or careless players would otherwise keep going for ever, together
  with its action log (08 T25, storage).
- When more than one ending applies to a transition, `all-found` comes first, then
  `last-standing`, then `move-limit`.
- Every seat's `score` in `result()` is its pairs found, for display. `endReason` is `all-found`,
  `last-standing` or `move-limit`.
- **Whenever the game ends, nothing stays turned**: `turned` and `lastMiss` are cleared in the
  ending transition, so a finished view holds only `matched` cards and `down` cards with their face
  set (§8.4).

## 7. Options

```ts
Options = {
  grid: "4x4" | "4x5" | "5x6" | "6x6",   // default "4x5"
}
```

- The field is optional in the input and defaults to `"4x5"`; `undefined` or `null` means the
  defaults. Errors from `resolveOptions`, as in paths (paths §6): `OPTIONS_NOT_OBJECT`;
  `UNKNOWN_OPTION` (`detail: { option }` only when the key matches `^[A-Za-z0-9_]{1,64}$`, so
  arbitrary input is never echoed); `INVALID_OPTION` (`detail: { option }`) for any other value.
  Options carry no versions, and resolved options resolve to themselves (02 §2.1 rule 10).
- `catalog()`: `{ grid: { values: ["4x4", "4x5", "5x6", "6x6"], default: "4x5" }, grids: [{ id:
  "4x4", columns: 4, rows: 4, pairs: 8, moveLimit: 256 }, { id: "4x5", columns: 4, rows: 5, pairs:
  10, moveLimit: 400 }, { id: "5x6", columns: 5, rows: 6, pairs: 15, moveLimit: 900 }, { id: "6x6",
  columns: 6, rows: 6, pairs: 18, moveLimit: 1296 }], faces: 18 }`.
- `players(options)` = `{ min: 2, max: 6 }` for every grid: with more seats a `missed` pair reaches
  too few of them, and an 8-pair grid shared by more than 6 gives most players a pair or none.
  No resources. `validateStart` always succeeds.
- `defaultTurnTimeoutDays` = 3, as paths: families play at a quicker pace, and each card restarts
  the clock (§3). The timeout itself is the framework's (02 §4).
- Module config: none (`configSchema` is a strict empty object; `checkConfig` always succeeds).
- Nothing else is an option in v1. Variants (no extra turn after a match, larger grids, other face
  sets) would come later as options or new rules versions.

## 8. Module contract implementation

### 8.1 State (secret, server-only)

```ts
State = {
  options: { grid },
  faces: FaceId[],                    // the layout by card index; each face in play on two cards
  matchedBy: (Seat | null)[],         // by card index: the seat that found its pair, or null
  turned: number | null,              // card index of the turn's first card while it is up
  lastMiss: { seat: Seat, cards: [number, number] } | null,  // the missed pair while shown, in the order turned
  turn: Seat | null,                  // the seat to act; null once over
  out: ({ atMove: number, reason: "resigned" | "timed_out" | "declined" } | null)[],  // by seat
  moves: number,                      // module transitions so far
  endReason: null | "all-found" | "last-standing" | "move-limit",
}
```

- `out.atMove` is the value of `moves` before the transition that put the seat out (the leaving
  order, §6). `columns`, `rows`, `pairs` and the move limit `4 × pairs²` come from
  `options.grid`.
- **Invariants**: `turned !== null ⇒ lastMiss === null` (the first card clears the missed pair, and
  a miss sets it only as it clears `turned`); `turned` and `lastMiss` cards are never matched;
  `endReason !== null ⇔ turn === null`, and then `turned` and `lastMiss` are both null (§6).
- **Hidden information**: the faces of the **hidden cards**, those with `matchedBy` null that are
  neither `turned` nor in `lastMiss`, while `endReason` is null. They are hidden from every seat and
  the public alike, and a face turned back down is hidden again (§4). Nothing is hidden once the game
  is over. Which faces are in play is public (§2).

### 8.2 Turn functions

- `toAct`: `[turn]` while in progress, `[]` once over.
- `seatStatus`: `out` once the seat resigned, timed out or declined; there is no elimination by
  the rules.
- `apply(state, seat, { type: "flip", row, column })`, for a valid flip by `turn`, with `c` the
  card index; `moves` goes up by one first. Exactly one branch applies:
  1. **First card** (`turned` null): `lastMiss = null`, `turned = c`.
  2. **Second card, match** (`faces[c] === faces[turned]`): `matchedBy[turned] = matchedBy[c] =
     seat`, `turned = null`; then
     - **last pair** (no card has `matchedBy` null): the game ends `all-found`;
     - **otherwise**, if `moves ≥ 4 × pairs²`, the game ends `move-limit`; else `turn` stays.
  3. **Second card, miss**: `lastMiss = { seat, cards: [turned, c] }`, `turned = null`; then if
     `moves ≥ 4 × pairs²` the game ends `move-limit`, else `turn` = the next playing seat after
     `seat` in turn order, wrapping.
- `onResign(state, seat, rng, reason)` and `onTimeout(state, seat, rng)`: `moves` goes up by one;
  `out[seat] = { atMove, reason }` with `atMove` the value before, and the reason mapped from the
  exit: `onResign` with `"resign"` → `"resigned"`, `onResign` with `"decline"` → `"declined"`,
  `onTimeout` → `"timed_out"`. Then:
  1. if `seat` is `turn`, `turned = null` (`lastMiss` is left as it is);
  2. if one seat is still playing, the game ends `last-standing`;
  3. else if `seat` was `turn` and `moves ≥ 4 × pairs²`, the game ends `move-limit`;
  4. else if `seat` was `turn`, `turn` = the next playing seat after `seat`, wrapping; otherwise
     `turn` is unchanged.
- **A game ending** sets `endReason`, `turn = null`, `turned = null` and `lastMiss = null` (§6).
- No transition draws randomness; only `setup` does.
- `result()`: null while `endReason` is null; then the ranking of §6, every seat with `score` =
  pairs found.

### 8.3 Actions and errors

```ts
Action = { type: "flip", row: number, column: number }   // strict; safe integers; in range is checked by validate
```

(Resign is a framework action that calls `onResign`.) `errorCodes`, checked in this order (first
failure wins), none with a `detail`:

1. `NOT_TO_ACT`: the seat isn't `turn`, or the game is over (`validate` for a seat outside `toAct`,
   which the framework never asks).
2. `OUT_OF_RANGE`: `row` outside `0..rows−1` or `column` outside `0..columns−1`.
3. `CARD_FACE_UP`: the card is `matched` or is the turn's `up` card. A `missed` card is legal.

plus `OPTIONS_NOT_OBJECT`, `UNKNOWN_OPTION` and `INVALID_OPTION` from option resolution (§7). Every
check reads only `turn`, `endReason`, the grid size, `matchedBy` and `turned`, never a face (02 §2.1
rule 4). There is no `preview` (no `previewSchema`): nothing about a card can be said before it is
turned, and legality is visible in the view.

### 8.4 View

```ts
View = {
  grid: "4x4" | "4x5" | "5x6" | "6x6",
  columns: number, rows: number,
  faces: FaceId[],                    // the faces in play, ascending (public from the start)
  cards: Card[][],                    // cards[row][column]
  turn: Seat | null,
  pairs: number[],                    // pairs found, by seat
  out: (null | "resigned" | "timed_out" | "declined")[],  // by seat
  moves: number, moveLimit: number,   // moveLimit = 4 × pairs²
  endReason: null | "all-found" | "last-standing" | "move-limit",
}
Card =
  | { state: "down", face: null, by: null }            // in progress; once over, face is set
  | { state: "up", face: FaceId, by: Seat }            // the turn's first card; by = the seat to act
  | { state: "missed", face: FaceId, by: Seat }        // by = the seat whose turn it was
  | { state: "matched", face: FaceId, by: Seat }       // by = the seat that found the pair
```

- `view(state, viewer)` doesn't depend on `viewer`: every seat and the public see the same (§4).
- Once `endReason` is set, every card is `matched` or `down` with its face set (`{ state: "down",
  face, by: null }`; §6). After a framework-only ending (`declined`) or an operator cancel, the
  stored final view is the in-progress view of the frozen state (02 §4, §5): `endReason` is null,
  `down` faces stay null, and an `up` card or `missed` pair shown when it stopped stays shown.
- Keys are always in the order shown; `cards` is in grid order and `faces` ascending, so nothing in
  the view's shape follows the layout.

### 8.5 Records, `describe` and `summary`

```ts
PairsRecord =                                         // discriminated by type
  | { type: "flip", seat: Seat, step: 1 | 2 }
  | { type: "resign" | "timeout" | "decline", seat: Seat }
```

- `step` is 1 for the turn's first card and 2 for its second (public: it follows from the state
  before). A record names **no card**: not its position, its face, whether a pair matched, who goes
  next or what was turned back (Q31). The view shows the cards (02 §2.1 rule 5, §6.3: every flip
  leaves a card face up in every view, so two different flips never look the same to the others).
- `describe`: `[{seat:0}, " turned over a card"]` for step 1; `[{seat:0}, " turned over a second
  card"]` for step 2; `[{seat:1}, " resigned"]`; `[{seat:1}, " ran out of time"]`; `[{seat:1}, "
  declined the game"]`. So a push reads "Ann turned over a second card. Your turn." (03 §7).
- `summary(state, viewer)`: in progress, with `N` the pairs not yet found, `"N pairs left · your
  turn"` for the seat to act (`"1 pair left"` for one) and `"N pairs left · ", {seat}, " to play"`
  for anyone else and the public; once over, `[{seat}, " won"]` when one seat ranks 1, `"Shared
  win"` otherwise. `scores`: pairs found, by seat.

### 8.6 Schema bounds

Every object is strict (no other keys); every number is an integer.

- `configSchema`: the empty object.
- Options input: `grid` one of the four ids, optional; resolved options: `{ grid }`, required.
- `actionSchema`: `type` `"flip"`; `row` and `column` safe integers (range checked by `validate`).
- `viewSchema`: `grid` one of the four ids; `columns` and `rows` 4–6; `faces` 8–18 distinct ids
  0–17, ascending; `cards` 4–6 rows of 4–6 cards; a card's `face` 0–17 (or null for `down`), its
  `by` 0–5 (or null for `down`); `turn` 0–5 or null; `pairs` and `out` 2–6 entries, each pair count
  0–18; `moves` 0–1,303 (a constant: the largest `maxActions`, `6x6` at 6 seats, §8.7; that a
  game's `moves` stays within its own `maxActions` is a refinement the engine's tests check, not
  Zod); `moveLimit` one of 256, 400, 900, 1,296. Shape-level checks only: that `cards` matches `columns × rows` and `faces` holds
  `pairs` ids is the engine's (and the tests') business, not Zod's.
- `recordSchema`: `seat` 0–5, `step` 1 or 2; no arrays.
- `catalogSchema`: as §7, with exactly the four grids.

### 8.7 Kit hooks

- `hiddenInformation: true` and **`hiddenFromEveryone: true`**: while the game is in progress, every
  seat and the public get the same view (identical JSON; summaries differ only in "your turn"),
  which is exactly what the flag means (02 §6.3), and the kit checks that at every step. The kit
  then counts a sample by whether `perturbHidden` changed the state. `publicRandomness` is unset: no
  transition draws randomness.
- `perturbHidden(state, viewer, rng)`, the same for every `viewer` and `null`: the faces of the
  hidden cards (§8.1), in card-index order, are shuffled with `rng` and written back to the same
  cards; if that reproduces the state and the hidden cards hold two or more different faces, the
  faces of the first hidden card and the first later hidden card with a different face are swapped
  instead, so the result always differs when it can. Nothing else changes (`{ ...state, faces }`,
  key order kept); a finished game is returned unchanged. So the multiset of faces, the faces in
  play and every shown card stay as they were.
  - What the kit then proves, **relative to the hidden set of §8.1**: no view, summary, `toAct`,
    `seatStatus`, end test or `validate` answer depends on the faces of the cards that set names,
    and no record depends on any face. It does not prove the set itself is right (for example that
    a `missed` pair leaves it, and returns to it, at the right moment): the rule tables and the
    oracle test of §10 do.
  - Non-vacuity: the state changes at every sample except those where the hidden cards all share
    one face (the last pair, or only the turn's first card's partner), so well over half of the
    samples count.
- **The secret-choice check** (02 §6.3) passes by construction: flips of different cards leave
  different cards face up in every other viewer's view, and every flip of the same step gives the
  same record.
- `randomAction(state, seat, rng)`: uniform among the legal flips (every card that isn't `matched`
  or `up`; `missed` ones included). It reads no face.
- `randomAnyAction(state, seat, rng)`: schema-valid and often illegal: mostly a uniformly random
  card in the grid (matched, up, missed or down), sometimes a row or column one outside the grid,
  now and then a large integer.
- `maxActions(options, seats)` = `4·pairs² + seats + 1` (259 at `4x4` with 2 seats, 1,303 at
  `6x6` with 6), from the move limit (§6). Proof, with `L = 4·pairs²`: every module transition
  adds one to `moves`, so transition number `L` is the one that brings `moves` to the limit. If it
  was a second card or a leave by the seat to act, the game ends there. Otherwise it was a first
  card or a leave by another seat, and the game ends at the next second card or the next leave by
  the seat to act (§8.2). Until then the only other transitions are at most one first card (only
  if the limit was reached between turns, by another seat's leave) and leaves by seats not to act.
  A game has at most `seats − 1` leaves in all (the last but one ends it), and when the limit was
  reached by a leave, that leave is one of them. So at most `seats` transitions follow transition
  `L` in either case (a first card, the ending second card and `seats − 2` further leaves; or the
  ending transition and `seats − 1` leaves at most, the last of which would end the game), and
  `L + seats + 1` leaves a margin of one.
- `worstCase(options, seats, rng)`: built by seeded play from `setup` at the given options and seat
  count, so every input is a reachable state. Its own drivers (not `randomAction`; they may read
  the layout) play two kinds of game. One turns the partner of the `up` card half the time, so it
  reaches the end, and gives a first card while a `missed` pair is shown (apply clears it), a
  second card that misses (the next-seat search) and the second card that finds the last pair
  (the end and the ranking). The other always **misses on purpose** (it picks a second card whose
  face differs from the `up` card's, which is possible while two or more faces are unmatched, so
  from the start), until the second card that reaches the move limit, which ends the game
  `move-limit`. `validate` is a few lookups and `apply` copies at most 36
  cards and 6 seats, so the costliest inputs are the largest grid's; the engine's tests report the
  measured p99, expected to be microseconds against the 5 ms budget (08 T25). Its honesty rests on
  that reading of the code, which the review checks.
- `optionInputs`: `[{}, { grid: "4x4" }, { grid: "5x6" }, { grid: "6x6" }]` (`{}` is `4x5`), each
  at 2–6 seats. No `context` or `resources` hooks.

### 8.8 Manifest

`type: "pairs"`, `name: "Pairs"` (working name, Q32), a one-line description ("Turn over two cards
at a time and find the matching pairs."), an original SVG icon (two cards, one face up), `licence`
as the package, `resources: []`, `hiddenInformation: true` (so an owner's AI seats are allowed only
against their own AI accounts, 02 §4; every seat sees the same, but the flag is binary), `players:
{ min: 2, max: 6 }`. The rules text (version 1) states the rules of §3–§6 (the move limit included),
that the missed pair stays face up only until the next player turns their first card, that the
history says who turned cards but never which, and that writing faces down, screenshots or a tool
that remembers for you spoil the game for everyone else, who can't tell.

## 9. UI notes (games/pairs client)

- **Card size**: square, `min(88 px, (content width − (columns − 1) × 4 px) / columns)`, with
  4 px gaps; the content width is the viewport less the page's two 16 px gutters, up to the shell's
  column. At 320 px wide that is 44.7 px at 6 columns, 54.4 px at 5 and 69 px at 4, so every card
  is a touch target of at least 44 × 44 CSS px (WCAG 2.5.5) and 6 columns is the most a grid has.
  A `6x6` board is 288 px tall there and `4x5` 361 px. Every other control is at least 44 × 44 CSS
  px too.
- **Layout**, top to bottom: the players, the turn line ("Your turn: turn over a card", "… a
  second card", "Sam to play"), the board, and a live status line. The board owns the players and
  the turn (02 §3).
  - **The players area is compact**: at widths under 480 px, two columns of one line each
    ("1 Ann · 3", "2 Sam · out"), so 2–4 players take two lines and 5–6 three; on wider screens one
    wrapped line. A player who left shows "out" and, if they keep any pairs, their count after it
    ("2 Sam · out (3)"). Near the limit the turn line adds "N moves left", where `N = moveLimit − moves`
    (from the view): from when `N < 2 × p`, with `p` the seats still playing (about one turn each
    left), and it stays visible until the game ends.
  - **Above the fold**: at 320 × 568 the whole board, not just its top (02 §3), is on the first
    screen for 2–4 players on every grid, and the e2e asserts it. With 5–6 players the players area
    takes a third line, and on `4x5` the board's last row may need a short scroll; that trade-off
    is accepted rather than shrinking cards below 44 px.
- **Turning a card**: on your turn, tap a card that isn't matched or up. There is no confirm: one
  tap is one action, as at a table. While the request is in flight every card is inactive and the
  tapped one shows a turning state: a `down` card with no face, a `missed` card with its face (it is
  in the current view) and its outline; the other cards keep what the current view shows. The
  face appears from the view the submit returns, never earlier. On an error the shell's stale-state
  refetch applies (02 §3). Off turn the cards are inactive (`aria-disabled`, still focusable so they
  can be read).
- **The reveal when your turn opens**: each `missed` card is drawn face up with its own outline and
  a badge with the number of the player whose turn it was. The status line says the rest: "Sam's
  last turn: moon (row 1, column 2) and key (row 3, column 4). They turn face down when you turn
  your first card." Tapping one of them turns it as your first card (it stays face up as yours) and
  the other goes down. After your second card the line says "A pair of stars! Your turn again." or
  "No match. Sam to play." (after the last pair, "A pair of stars!" alone), above the line that
  says what the view now shows; the next change of the view replaces it.
- **Off turn**, the status line says whose turn it is and what is shown: "Sam to play.", "Sam
  turned over a star (row 2, column 3).", or, while a missed pair is shown, "Ann's last turn: moon
  (row 1, column 2) and key (row 3, column 4)."
- **The board never remembers for the player**, on screen, in the DOM or in the accessibility tree:
  - it renders only what the current view shows: a `down` card renders no face element, and no
    class, React key, `data-` attribute, title or accessible text derived from a face (cards are
    keyed by position);
  - the turn-down animation may draw the previous face only for its own duration, and then removes
    that node; with `prefers-reduced-motion` there is none;
  - the status line is replaced whenever the view changes and never names a face the current view
    doesn't show; nothing is kept in storage (no `localStorage` use at all);
  - a page restored from the back-forward cache (`pageshow` with `persisted`) refetches the game
    before showing it, so an old view can't come back (the shell does this, for every game).
- **Faces** are drawn as SVG React elements from our own artwork (§1), with `viewBox` and class
  names, decorative and `aria-hidden`; the card back is one pattern. Matched cards are drawn
  dimmed with a check and the finder's player number; words or numbers always go with colour. A
  player number on a card is drawn by CSS from a `data-` attribute, not as text in the button, so
  the button's visible label is its name (WCAG 2.5.3).
- **Accessible names** (rows and columns from 1): "Row 2, column 3, face down"; "Row 2, column 3,
  star, your first card"; "Row 2, column 3, star, Sam's first card"; "Row 1, column 2, moon, Sam's
  last turn, turns face down at the next first card"; "Row 4, column 4, apple, matched by Ann" ("matched by you" for the viewer's own pairs, "your"
  for the viewer's own cards in the names above). In a finished game a card left down shows its
  face, named "Row 2, column 3, star, not found".
- **Grid semantics**: the board is a `role="grid"` labelled "Cards", with a `role="row"` per row
  and a `role="gridcell"` per card holding the card's `<button>`, so screen readers can move by row
  and column in focus mode. Arrow keys move between cards (one tab stop, roving `tabindex`), Enter
  or Space turns the focused card (07 §6). Status text is in a polite live region that is always in
  the page.
- **Motion**: a card turns with a short flip (about 250 ms) both ways; with
  `prefers-reduced-motion` faces appear and go without animation.
- **Shared display names**: players who share a name are written with their number, "Ann (player
  2)", in every line the board writes and in history items.
- **Theme**: as paths (paths §8): the page's light or dark theme, colours as board tokens with each
  theme's contrast tested: face drawings at least 3:1 against their card (WCAG 1.4.11), dimmed
  matched cards included; badge and status text at least 4.5:1; the card back against the page.
- **Finished or stopped game**: the board never offers a tap and shows no turn line; the shell's
  result card owns the ranks, and the board's final summary says how the game ended in its own
  words, since the shell's ending text knows only the framework's reasons (02 §3):
  - `all-found`: "All the pairs were found.";
  - `last-standing`: "Only Ann was left playing." (the one seat still playing);
  - `move-limit`: "The move limit (N moves) was reached with K pairs still face down." (`N` =
    `moveLimit`, `K` the pairs not found);

  then every card's face and each player's pairs ("Ann found 3 pairs. Sam found 1 pair and left
  the game."). After a framework-only ending or a cancel
  (`endReason` null in the frozen view, §8.4) it adds no ending line and draws the frozen view as it
  is, face-down cards still blank; an `up` or `missed` card keeps its face and gets a stopped-game
  name without the in-play hints: "Row 2, column 3, star, Sam's first card when the game stopped";
  "Row 1, column 2, moon, Sam's last turn".
- Options form: the grid as radios ("4 × 4: 8 pairs, quickest" … "6 × 6: 18 pairs, longest").
  The rules sheet states the game's options, then the manifest's rules for its version.
  `HistoryItem` renders the record's `describe` text with names (and the shared-name number); it
  draws no cards.

## 10. Module-specific tests

Rule tables in addition to the kit, with a seeded `RandomSource`:

- **Setup**: each grid's size and pair count; every face in play on exactly two cards; `pairs`
  distinct faces in play, all 18 at `6x6`; the 18 ids are shuffled on every grid, and the deck is
  built ascending before its shuffle; the same seed gives the same layout and faces.
- **A turn**: a first card clears a shown `missed` pair and keeps the seat in `toAct`; a match
  scores the pair and keeps the turn; a miss shows both and passes the turn to the next playing
  seat, skipping seats that are out and wrapping; the last pair ends the game `all-found`; a
  `missed` card is a legal first card.
- **Move limit**: a miss, a match and a leave by the seat to act at the limit each end the game
  `move-limit`; a first card at the limit doesn't, nor does a leave by another seat; `all-found`
  and `last-standing` take precedence; the ranking is as `all-found`.
- **Errors**: every code in its order (not to act, out of range on each side, matched, up) and the
  game over; none carries a `detail`.
- **Views**: identical for every seat and the public in progress; `down` faces null in progress
  and set once `endReason` is set; a `missed` pair in every view until the next first card and in
  none after; a face shown as `up` and then turned back by a resignation in no view after it.
- **Leaving**: resign, timeout and decline before the first card (a shown pair kept), mid-turn
  (the card turned back) and off turn (the turn kept); the exit-reason mapping; a 2-player
  resignation ends `last-standing`; a leaver's pairs kept as its score; a leave that ends the game
  mid-turn, or while a missed pair is shown, leaves a finished view with only `matched` and `down`
  cards (faces set).
- **Ranking**: ties sharing a rank, leavers below every seat still playing whatever their pairs,
  later leavers higher, `last-standing` with several leavers.
- **Records and text**: every record shape and its `describe` text, and the summary lines; no
  record or text contains a row, column or face.
- **Invariants and an independent oracle** (property test over seeded random games with exits): the
  §8.1 invariants hold at every state; and a separate model written from §3–§6 alone, fed the
  **actions** applied (not the records) and the layout, predicts at every step which cards show a
  face and in which state; the view's `cards` must equal it exactly.
- **Kit coverage** (a test over the kit's own fast-mode games, with its seeds): on every grid at
  least 90 % of the games played with no seat leaving end `all-found` (about 98 % or more is
  expected under the uniform `randomAction`, §6), so the endgame is played and not cut off by the
  limit; and the secrecy samples include in-progress states with at most 4 hidden cards on every
  grid, so the last pairs' faces are perturbed too.
- **Hooks**: `perturbHidden` changes only hidden cards' faces, keeps the multiset, the faces in
  play and the key order, changes the state whenever two hidden faces differ, and leaves a finished
  game alone; `randomAction` always validates and reads no face (it gives the same flip on a state
  and on its perturbation, with the same draws); random games with exits stay within `maxActions`
  (a property test); `worstCase` returns real moves for every grid and seat count, the four kinds
  included.
