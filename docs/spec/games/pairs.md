# Game module: `pairs`

The traditional memory game for 2–6 players, for families (younger players included, playing
through a parent's account, Q20): a grid of cards lies face down, each face on exactly two cards.
On your turn you turn over two cards. If they match, you keep the pair and go again; if not, they
turn back face down and the next player goes. When every pair is found, the player with the most
pairs wins.

The game itself is traditional and public domain. Some commercial editions' names are trademarks,
so the module never uses them: it is called **Pairs**, its UI describes it in plain words ("turn
over cards to find the pairs"), and its card faces and card back are our own artwork.

**The design problem.** Played asynchronously, the game loses its point if anything shows every card
turned: anyone could scroll back. So a card's face reaches players only through `view`, and only
while the card is face up (§4). Records name positions, never faces or whether a pair matched
(02 §2.1 rule 5). The design comes from the owner's note in 10 §Later; this document settles it.

## 1. Components

- **Grid**: `columns × rows` cards, chosen by the `grid` option (§7). Card `(row, column)`: row from
  the top, column from the left, both from 0. Its **card index** is `row × columns + column`
  (reading order); the state stores cards in that order.

  | `grid` | Columns | Rows | Cards | Pairs |
  |---|---|---|---|---|
  | `4x4` | 4 | 4 | 16 | 8 |
  | `4x5` (default) | 4 | 5 | 20 | 10 |
  | `5x6` | 5 | 6 | 30 | 15 |
  | `6x6` | 6 | 6 | 36 | 18 |

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

## 2. Setup

1. Turn order = seat order (the framework's `seatOrder`, 02 §4); seat 0 turns first.
2. **Faces in play**: for `pairs < 18`, the 18 face ids are shuffled with the `rng` and the first
   `pairs` are kept; for `6x6`, all 18. Which faces are in play is public (the view lists them,
   §8.4); where they lie is not.
3. **Layout**: the faces in play, each twice, are shuffled with the `rng` (the SDK's `shuffle`)
   into card-index order. The layout is secret state: no card's face reaches any seat until the
   card is turned (§4).

## 3. A turn

A turn is two actions, each its own transition (02 §2.3): turn a first card, then, having seen it,
a second.

1. **First card**: the player to act turns over any card not `matched` (a `missed` card included).
   It is now `up`, and the previous turn's `missed` pair, if any, goes face down (§4). The player
   stays in `toAct`.
2. **Second card**: the player turns over any other card not `matched`.
   - **A match** (same face): both cards are `matched`, the pair is the player's, and the same
     player takes another turn. If it was the last pair, the game ends (§6).
   - **No match**: both cards become the `missed` pair, shown to every seat until the next first
     card is turned. The turn passes to the next seat in turn order that is still playing
     (wrapping round).
3. Each accepted card restarts the player's clock (02 §2.3), so a turn that finds pairs may last
   longer than one turn timeout; each card is progress, and every turn ends after at most
   `pairs` matches.

A card's face is never known to the client before the server answers: the board shows it from the
view that the submit returns (§9).

## 4. What each player sees

This is the core of the design. While the game is in progress, **every seat and the public get the
same view**, and it shows a card's face exactly when:

| Card | Face in the view |
|---|---|
| `matched` | shown, with the seat that found it |
| `up` (the first card of the turn in progress) | shown |
| `missed` (the previous turn's unmatched pair) | shown, with the seat whose turn it was, **until the next first card is turned** |
| every other card | hidden (`null`), including cards that were face up earlier and turned back |

- The `missed` pair is cleared by the next first card turned in the game, whoever turns it.
  Normally that is the next seat. If that seat leaves before turning a card (§5), the pair stays
  shown for the seat that then has the turn.
- Once cleared, those faces are gone from every view, and nothing else serves them (history and
  notifications carry records and `describe` text only, §8.5; a finished game displays from
  `final_views`, 02 §5). **Remembering them is the game.**
- With 3 or more seats, only the next seat is sure to see a `missed` pair; the others see it only
  if they look before that seat's first card (accepted, design note).
- Once the game is over, the view shows every card's face, so a game that ended with cards still
  down (§6) shows where the rest were.

What the history does tell (accepted): records name the positions turned (§8.5), and who turned
next shows whether a turn matched. So a careful reader can learn that two cards turned together
differ, and, late in a game, combine that with the pairs found since to work out where a pair lies
without having remembered a face. That is less than any player who watched every turn knows, and
much less than the residual below; Q31 records the alternative.

Screenshots, notes and any client that polls the view (a script, or an assistant reading views
with a `read` token, which 02 §9.3 always allows) remember for their player. That defeats the game
for that player and is accepted for a family game; the rules text says so (§8.7).

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
  resignation or timeout does this.

## 6. End of game

- **All pairs found** (`all-found`): the seats still playing rank by pairs found, most first,
  ties sharing a rank (standard competition ranking, 02 §4). Seats that left (resigned, timed out
  or declined) rank below every seat still playing, whatever their pairs, the most recent leaver
  highest (one seat leaves per transition, so they never tie). The framework then drops declined
  seats from the ranking and re-ranks the rest (02 §4).
- **Last standing** (`last-standing`): the one seat still playing ranks 1; the others rank by when
  they left, the most recent highest. Cards still down stay down.
- Every seat's `score` in `result()` is its pairs found, for display. `endReason` is `all-found`
  or `last-standing`.

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
  "4x4", columns: 4, rows: 4, pairs: 8 }, { id: "4x5", columns: 4, rows: 5, pairs: 10 }, { id:
  "5x6", columns: 5, rows: 6, pairs: 15 }, { id: "6x6", columns: 6, rows: 6, pairs: 18 }], faces: 18
  }`.
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
  endReason: null | "all-found" | "last-standing",
}
```

`out.atMove` is the value of `moves` before the transition that put the seat out (the leaving
order, §6). `columns`, `rows` and `pairs` come from `options.grid`.

**Hidden information**: the faces of the **hidden cards**, those with `matchedBy` null that are
neither `turned` nor in `lastMiss`, while `endReason` is null. They are hidden from every seat and
the public alike, and a face turned back down is hidden again (§4). Nothing is hidden once the game
is over. Which faces are in play is public (§2).

### 8.2 Turn functions

- `toAct`: `[turn]` while in progress, `[]` once over.
- `seatStatus`: `out` once the seat resigned, timed out or declined; there is no elimination by
  the rules.
- `apply` (a valid `flip` by `turn`; `moves` goes up by one):
  - first card (`turned` null): `lastMiss = null`, `turned` = the card.
  - second card: `turned = null`; if its face equals the `turned` card's, both `matchedBy` = the
    seat, and if no card is unmatched, `endReason = "all-found"` and `turn = null`; otherwise
    `lastMiss = { seat, cards: [first, second] }` and `turn` = the next playing seat after `seat`
    in turn order, wrapping.
- `onResign(state, seat, rng, reason)` and `onTimeout(state, seat, rng)`: `out[seat] = { atMove:
  moves, reason }` (`reason` `resigned`, `declined` or `timed_out`), `moves` goes up by one; if
  `seat` is `turn`, `turned = null` (`lastMiss` is left as it is); then if one seat is still
  playing, `endReason = "last-standing"` and `turn = null`, else if `seat` was `turn`, `turn` = the
  next playing seat after it. Neither draws randomness; neither does `apply` (only `setup` does).
- `result()`: null while `endReason` is null; then the ranking of §6, every seat with `score` =
  pairs found.

### 8.3 Actions and errors

```ts
Action = { type: "flip", row: number, column: number }   // safe integers; in range is checked by validate
```

(Resign is a framework action that calls `onResign`.) `errorCodes`, checked in this order (first
failure wins), none with a `detail`:

1. `NOT_TO_ACT`: the seat isn't `turn`, or the game is over (`validate` for a seat outside `toAct`,
   which the framework never asks).
2. `OUT_OF_RANGE`: `row` outside `0..rows−1` or `column` outside `0..columns−1`.
3. `CARD_FACE_UP`: the card is `matched` or is the turn's `up` card. A `missed` card is legal.

plus `OPTIONS_NOT_OBJECT`, `UNKNOWN_OPTION` and `INVALID_OPTION` from option resolution (§7). Every
check reads only `turn`, the grid size, `matchedBy` and `turned`, never a hidden face (02 §2.1
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
  endReason: null | "all-found" | "last-standing",
}
Card =
  | { state: "down", face: null, by: null }            // in progress; once over, face is set
  | { state: "up", face: FaceId, by: Seat }            // the turn's first card; by = the seat to act
  | { state: "missed", face: FaceId, by: Seat }        // by = the seat whose turn it was
  | { state: "matched", face: FaceId, by: Seat }       // by = the seat that found the pair
```

- `view(state, viewer)` doesn't depend on `viewer`: every seat and the public see the same (§4).
- Once the game is over, `down` cards carry their face (`{ state: "down", face, by: null }`); the
  other states are as they were.
- Keys are always in the order shown; `cards` is in grid order and `faces` ascending, so nothing in
  the view's shape follows the layout.
- Bounds (Zod): `cards` 4–6 rows of 4–6 cards (as many as the grid has); `faces` at most 18 distinct ids 0–17; `pairs` and
  `out` 2–6 entries (one per seat); seats 0–5; `columns` and `rows` 4–6.
- History comes from the framework's history endpoint (02 §3), not the view.

### 8.5 Records, `describe` and `summary`

```ts
PairsRecord =                                         // discriminated by type
  | { type: "flip", seat: Seat, step: 1 | 2, row: number, column: number }
  | { type: "resign" | "timeout" | "decline", seat: Seat }
```

- `step` is 1 for the turn's first card and 2 for its second (public: it follows from the state
  before). A record never names a face, whether a pair matched, who goes next or what was turned
  back; those reach players through `view` (02 §2.1 rule 5). Record bounds: seats 0–5, `row` and
  `column` 0–5; no arrays.
- `describe` (rows and columns counted from 1): `[{seat:0}, " turned over a card (row 2, column
  3)"]` for step 1; `[{seat:0}, " turned over a second card (row 4, column 1)"]` for step 2;
  `[{seat:1}, " resigned"]`; `[{seat:1}, " ran out of time"]`; `[{seat:1}, " declined the game"]`.
  So a push reads "Ann turned over a second card (row 4, column 1). Your turn." (03 §7).
- `summary(state, viewer)`: in progress, with `N` the pairs not yet found, `"N pairs left · your
  turn"` for the seat to act (`"1 pair left"` for one) and `"N pairs left · ", {seat}, " to play"` for anyone else and the public; once
  over, `[{seat}, " won"]` when one seat ranks 1, `"Shared win"` otherwise. `scores`: pairs found,
  by seat.

### 8.6 Kit hooks

- `hiddenInformation: true` and **`hiddenFromEveryone: true`**: everything hidden (§8.1) is hidden
  from every seat alike, so no perturbation can change one viewer's view and not another's, and
  the kit counts a sample by whether `perturbHidden` changed the state (02 §6.3). "Hidden from
  everyone" holds at every state: a face seen earlier and turned back is hidden from every seat
  again, which is exactly what the kit then tests. `publicRandomness` is unset: no transition draws
  randomness.
- `perturbHidden(state, viewer, rng)`, the same for every `viewer` and `null`: the faces of the
  hidden cards (§8.1), in card-index order, are shuffled with `rng` and written back to the same
  cards; if that reproduces the state and the hidden cards hold two or more different faces, the
  faces of the first hidden card and the first later hidden card with a different face are swapped
  instead, so the result always differs when it can. Nothing else changes (`{ ...state, faces }`,
  key order kept); a finished game is returned unchanged. So the multiset of faces, the faces in
  play and every shown card stay as they were.
  - What the kit then proves: no view, summary, `toAct`, `seatStatus`, end test or `validate`
    answer depends on a face that is down, including one turned back after a miss, and no record
    depends on a face or on whether a pair matched (02 §6.3).
  - Non-vacuity: the state changes at every sample except those where the hidden cards all share
    one face (the last pair, or only the turn's first card's partner), at most the game's last turn,
    so well over half of the samples count.
- **The secret-choice check** (02 §6.3) passes by construction: flips of different cards leave
  different cards face up in every other viewer's view, and the same card gives the same record.
- `randomAction(state, seat, rng)`: the first card uniform among the legal cards (`missed` ones
  included). The second card is the partner of the `up` card (the other card with its face) once
  `moves ≥ 4 × pairs²`, and before that the partner with probability 1/3, otherwise uniform among
  the legal cards. Only the kit and `games:verify` read it (02 §6); the partner rule is what makes
  termination provable.
- `randomAnyAction(state, seat, rng)`: schema-valid and often illegal: mostly a uniformly random
  card in the grid (matched, up, missed or down), sometimes a row or column one outside the grid,
  now and then a large integer.
- `maxActions(options, seats)` = `4·pairs² + 2·pairs + 2·seats`. Proof: at most `4·pairs²`
  transitions happen before the cap. After it every second card matches, so there are at most
  `pairs` second cards; every first card after it is followed by a matching second card or
  abandoned by an exit; and there are at most `seats` exits. That bounds what follows the cap by
  `2·pairs + 2·seats` (1,344 at `6x6` with 6 seats).
- `worstCase(options, seats, rng)`: built by seeded play from `setup` with `randomAction` at the
  given options and seat count, so every input is a reachable state: a first card while a `missed`
  pair is shown (apply clears it), a second card that misses (the next-seat search), and the second
  card that finds the last pair (the game's end and the ranking). `validate` is a few lookups and
  `apply` copies at most 36 cards and 6 seats, so the costliest inputs are the largest grid's; the
  engine's tests report the measured p99, expected to be microseconds against the 5 ms budget
  (08 T25). Its honesty rests on that reading of the code, which the review checks.
- `optionInputs`: `[{}, { grid: "4x4" }, { grid: "5x6" }, { grid: "6x6" }]` (`{}` is `4x5`), each
  at 2–6 seats. No `context` or `resources` hooks.

### 8.7 Manifest

`type: "pairs"`, `name: "Pairs"`, a one-line description ("Turn over two cards at a time and find
the matching pairs."), an original SVG icon (two cards, one face up), `licence` as the package,
`resources: []`, `hiddenInformation: true` (so an owner's AI seats are allowed only against their
own AI accounts, 02 §4; every seat sees the same, but the flag is binary), `players: { min: 2, max:
6 }`. The rules text (version 1) states the rules of §3–§6, that the missed pair stays face up only
until the next player turns their first card, that the history says which cards were turned but
never what they showed, and that writing faces down, screenshots or a tool that remembers for you
spoil the game.

## 9. UI notes (games/pairs client)

- **Card size**: square, `min(88 px, (content width − (columns − 1) × 4 px) / columns)`, with
  4 px gaps; the content width is the viewport less the page's two 16 px gutters, up to the shell's
  column. At 320 px wide that is 44.7 px at 6 columns, 54.4 px at 5 and 69 px at 4, so every card
  is a touch target of at least 44 × 44 CSS px (WCAG 2.5.5) and 6 columns is the most a grid has.
  A `6x6` board is 288 px tall there and `4x5` 361 px, so the board's top stays on the first
  screen of a 320 × 568 phone (02 §3). Every other control is at least 44 × 44 CSS px too.
- **Layout**, top to bottom: the players (number, name, pairs found or "out"), the turn line
  ("Your turn: turn over a card", "… a second card", "Sam to play"), the board, and a live status
  line. The board owns the players and the turn (02 §3).
- **Turning a card**: on your turn, tap a card that isn't matched or up. There is no confirm: one
  tap is one action, as at a table. While the request is in flight every card is inactive and the
  tapped one shows a turning state with no face; the face appears from the view the submit returns,
  never earlier. On an error the shell's stale-state refetch applies (02 §3). Off turn the cards
  are inactive (`aria-disabled`, still focusable so they can be read).
- **The reveal when your turn opens**: `missed` cards are drawn face up with a visible label ("Sam's
  last turn", or "Your last turn") and their own outline, and the status line names them: "Sam's
  last turn: moon (row 1, column 2) and key (row 3, column 4). They turn face down when you turn
  your first card." Tapping one of them turns it as your first card (it stays face up as yours) and
  the other goes down. After your second card the line says "A pair of stars! Your turn again." or
  "No match. Sam to play.", the missed pair labelled "Your last turn".
- **The board never remembers for the player**: it draws only what the current view shows, and
  keeps no face from an earlier view on screen, in its status text or in storage (no
  `localStorage` use at all); the status line is replaced whenever the view changes and never
  names a face the current view doesn't show.
- **Faces** are drawn as SVG React elements from our own artwork (§1), with `viewBox` and class
  names, decorative and `aria-hidden`; the card back is one pattern. Matched cards are drawn
  dimmed with a check and the finder's player number, words or numbers alongside colour, never
  colour alone.
- **Accessible names** (rows and columns from 1): "Row 2, column 3, face down"; "Row 2, column 3,
  star, your first card"; "Row 1, column 2, moon, Sam's last turn, turns face down at the next
  first card"; "Row 4, column 4, apple, matched by Ann". The board is a region; arrow keys move
  between cards (one tab stop), Enter or Space turns the focused card (07 §6). Status text is in a
  polite live region that is always in the page.
- **Motion**: a card turns with a short flip (about 250 ms) both ways; with
  `prefers-reduced-motion` faces appear and go without animation.
- **Shared display names**: players who share a name are written with their number, "Ann (player
  2)", in every line the board writes and in history items.
- **Theme**: as paths (paths §8): the page's light or dark theme, colours as board tokens with each
  theme's contrast tested, including face drawings against the card and the card against the page.
- **Finished game**: the shell's result card owns the ranks; the board shows every card's face
  (`view` reveals them) and each player's pairs.
- Options form: the grid as radios ("4 × 4: 8 pairs, quickest" … "6 × 6: 18 pairs, longest").
  The rules sheet states the game's options, then the manifest's rules for its version.
  `HistoryItem` renders the record's `describe` text with names (and the shared-name number); it
  draws no faces.

## 10. Module-specific tests

Rule tables in addition to the kit, with a seeded `RandomSource`:

- **Setup**: each grid's size and pair count; every face in play on exactly two cards; `pairs`
  distinct faces in play, all 18 at `6x6`; the same seed gives the same layout and faces.
- **A turn**: a first card clears a shown `missed` pair and keeps the seat in `toAct`; a match
  scores the pair and keeps the turn; a miss shows both and passes the turn to the next playing
  seat, skipping seats that are out and wrapping; the last pair ends the game `all-found`; a
  `missed` card is a legal first card.
- **Errors**: every code in its order (not to act, out of range on each side, matched, up) and the
  game over; none carries a `detail`.
- **Views**: identical for every seat and the public in progress; `down` faces null in progress
  and set once over; a `missed` pair in every view until the next first card and in none after;
  a face shown as `up` and then turned back by a resignation in no view after it.
- **Leaving**: resign, timeout and decline before the first card (a shown pair kept), mid-turn
  (the card turned back) and off turn (the turn kept); a 2-player resignation ends `last-standing`;
  a leaver's pairs kept as its score.
- **Ranking**: ties sharing a rank, leavers below every seat still playing whatever their pairs,
  later leavers higher, `last-standing` with several leavers.
- **Records and text**: every record shape and its `describe` text, and the summary lines.
- **Hooks**: `perturbHidden` changes only hidden cards' faces, keeps the multiset, the faces in
  play and the key order, changes the state whenever two hidden faces differ, and leaves a finished
  game alone; `randomAction` always validates and plays the partner after the cap; random games
  with exits stay within `maxActions` (a property test); `worstCase` returns real moves for every
  grid and seat count.
