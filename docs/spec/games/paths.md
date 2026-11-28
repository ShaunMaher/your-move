# Game module: `paths`

A path-laying tile game for 2–8 players, a good fit for groups (younger players included, playing
through a parent's account, Q20). Each player guides a marker along paths that everyone builds
together. If your marker runs off the board, you're out; the last marker standing wins.

It shares its *mechanics* with an existing commercial game. Our module has its own name
(placeholder "Paths", Q21), theme and artwork. It never uses the commercial game's name, art,
dragon motif or look.

## 1. Components and geometry

- **Board**: `B × B` squares, `B = boardSize` (default 6). Square `(r, c)`: row `r` from the top,
  column `c` from the left, both `0..B-1`.
- **Notches**: each square edge has 2 notches, so each square (and tile) has 8, numbered 0–7
  clockwise starting at the left notch of the top edge:

  ```
        0   1
      ┌───────┐
    7 │       │ 2
      │       │
    6 │       │ 3
      └───────┘
        5   4
  ```

  Top edge 0 (left), 1 (right); right edge 2 (upper), 3 (lower); bottom edge 4 (right), 5 (left);
  left edge 6 (lower), 7 (upper).
- **Adjacency**: notch `n` of square `(r, c)` touches notch `n XOR 5` of the neighbouring square:
  0 ↔ 5 and 1 ↔ 4 with the square above; 2 ↔ 7 and 3 ↔ 6 with the square to the right (and the
  reverse for below and left). A notch with no neighbouring square is an **edge notch**.
- **Edge-notch index** `e` (`0..8B-1`), clockwise from the top-left corner of the board, with
  `k = ⌊e' / 2⌋` and `j = e' mod 2`:

  | Range | `e'` | Square | Notch |
  |---|---|---|---|
  | top `0..2B-1` | `e` | `(0, k)` | `j` |
  | right `2B..4B-1` | `e − 2B` | `(k, B−1)` | `2 + j` |
  | bottom `4B..6B-1` | `e − 4B` | `(B−1, B−1−k)` | `4 + j` |
  | left `6B..8B-1` | `e − 6B` | `(B−1−k, 0)` | `6 + j` |

- **Tiles**: each tile joins its 8 notches into 4 paths, a perfect matching of the 8 notches. The
  tile set is every distinct matching, counting tiles that are rotations of each other as the same.
  There are 105 matchings and exactly **35** distinct tiles (Burnside: (105 + 5 + 25 + 5) / 4). The
  engine generates them; a test asserts there are 35 and none is a rotation of another.
- **Rotation** `k ∈ {0, 1, 2, 3}` turns a tile `k × 90°` clockwise: a path `{a, b}` becomes
  `{(a + 2k) mod 8, (b + 2k) mod 8}`.
- **Tile ids**: write a matching as its 4 pairs, each pair ascending, pairs sorted. A tile's
  canonical form is the lexicographically smallest of its 4 rotations in that notation. Tiles are
  numbered 0–34 in lexicographic order of canonical form, and `rotation` in actions and state is
  relative to that canonical form. Ids are part of the module version.
- **Markers**: one per player, each with a distinct colour *and* shape (colour-blind safe). A
  marker's position is stored as `{ r, c, n }`: the **empty square it faces** and the notch of that
  square it sits on. (A notch between two squares belongs to both; this form is unambiguous and
  gives the placement target directly.)
- **Hand**: `handSize` tiles per player (default 3), hidden from other players.
- **Draw-order token**: tracks who draws first when tiles come back into a drawn-out deck (§4).

## 2. Setup

1. Turn order = seat order (the framework's `seatOrder`, 02 §4).
2. The deck (all 35 tiles) is shuffled with the `rng`.
3. **Marker phase**: in turn order, each player places their marker on any unoccupied edge notch
   (action `place-marker`). The tile phase starts after every player has placed. The player to act
   is always the first player in turn order who is not out and hasn't placed, so a player who
   resigns or declines in this phase is simply passed over.
4. Each player is dealt `handSize` tiles, in turn order (a full hand each, from the top of the
   deck, so no new random draw), when the tile phase starts. The first player in turn order who is
   not out takes the first tile turn.

## 3. A turn (tile phase)

1. The current player picks a tile from their hand and a rotation. It goes on **the square their
   marker faces**. There is no choice of location.
2. **Movement**: every marker facing the new tile's square (the mover's, and possibly others')
   follows the path it enters. It keeps following paths across adjacent placed tiles until it
   reaches a notch whose far side is an empty square (it now faces that square) or an edge notch.
   All affected markers move together, conceptually at the same time.
3. **Elimination**: a marker that ends on an edge notch is out (it ran off the board).
   - A **collision** is two markers travelling the same tile path in opposite directions during one
     movement. Because every path is reversible and every surviving marker's trail leads back to its
     starting edge notch, colliding markers always both end on edge notches, so they're out anyway.
     The engine reports them as `collided` in the record for display.
   - Two markers can never end on the same notch; the engine asserts this.
4. **Self-elimination rule** (`selfElimination: "avoidIfPossible"`, the default): a player may not
   choose a tile and rotation that eliminates their own marker if any tile and rotation in their hand
   avoids it. If every option eliminates them, they must still play one. With the variant
   `"allowed"`, any choice may be made. So under the default, a player who puts themselves out
   shows everyone that every tile and rotation in their hand would have done the same. That is by
   design, and the rules text says so.
5. **Draw**: if the mover survived, they draw one tile (§4). An eliminated mover doesn't draw.
   Eliminated players are marked out (and the draw-order token passed on, §4) before this draw.
6. Eliminated players' hand tiles are shuffled back into the deck and dealt out (§4).
7. **Next player**: the next surviving player in turn order who holds at least one tile. Surviving
   players with empty hands are skipped and listed in the record (`skipped`); they are never put in
   `toAct`. If no surviving player holds a tile, the game ends (§5); a move that ends the game
   lists nobody as skipped.

The movement result depends only on public information (board, markers) plus the mover's own tile.
So the client computes an exact preview locally: it draws the path the marker(s) would take and
flags eliminations before the player confirms.

## 4. Running out of tiles

- If the deck is empty when a player should draw, they draw nothing. If nobody holds the
  draw-order token, they take it.
- When tiles return to the deck (from eliminated, resigned or timed-out players' hands), they're
  shuffled in and dealt out at once: one at a time in turn order, starting with the token holder (or,
  if nobody holds it, with the next surviving player after the mover), to each surviving player with
  fewer than `handSize` tiles, until every hand is full or the deck is empty. "One at a time" goes
  round: each short player gets one tile per pass. For a resignation or timeout the leaving player
  counts as the mover; "after" always wraps around in turn order. The shuffle happens whenever
  tiles return, even if nobody is short or the game has just ended.
  - If the deck runs out while someone is still short, the token goes to the next short player in
    turn order after the last player dealt to.
  - Otherwise the token is cleared.
- If the token holder is eliminated, resigns or times out, the token passes to the next surviving
  player in turn order after them who has fewer than `handSize` tiles; if there is none, it's
  cleared. A mover who survives has just placed a tile, so it counts as short and can take the
  token this way. This happens before the returned tiles are dealt, so the deal starts with the
  new holder.
- So the token is only ever held while the deck is empty, and only by a surviving player who is
  short.

## 5. End of game

- **Last standing**: when exactly one player remains (not `out`), in either phase, they win
  (rank 1). Other players rank by
  elimination order: the most recently eliminated rank higher, and players eliminated in the same
  move tie (standard competition ranking, 02 §4).
- **Simultaneous wipe-out**: if the last markers are all eliminated in the same move, those players
  share rank 1.
- **Board full**: if no surviving player holds a tile (all tiles are placed or held by nobody — a
  6 × 6 board with 35 tiles leaves one square empty), every remaining player shares rank 1.
- **Resign / timeout / decline**: the player's marker is removed (`out`, reason `resigned`,
  `timed_out` or `declined`), their hand returns to the deck (§4), and play continues if two or
  more remain. With one left, they win. If it was their turn, play passes to the next player as
  after a move (§3 step 7); otherwise the player to act keeps the turn. A player who declines or
  times out before their first action (placing their marker) goes through `onResign(…,
  "decline")` (02 §2.1 rule 9): the marker and hand are handled the same way, but the record has
  type `decline` and says they declined, never that they resigned; the framework records them as
  `declined` and leaves them out of the ranking (02 §4).
- There are no points; `result()` returns ranks only. Its `endReason` is `last-standing`,
  `wipe-out` or `board-full`.

## 6. Options (variants)

```ts
Options = {
  boardSize: 6,                                   // only 6 in v1 (the 35-tile set is sized for it)
  handSize: 3,                                    // 1..3
  selfElimination: "avoidIfPossible" | "allowed",
}
```

- Every field is optional in the input and takes the default shown (`boardSize` 6, `handSize` 3,
  `selfElimination` `"avoidIfPossible"`); `undefined` or `null` means all defaults. Errors from
  `resolveOptions`, as in words (words §10.3): `OPTIONS_NOT_OBJECT`; `UNKNOWN_OPTION` (`detail: {
  option }` only when the key matches `^[A-Za-z0-9_]{1,64}$`, so arbitrary input is never echoed);
  `INVALID_OPTION` (`detail: { option }`) for a value outside the ones above. Options carry no
  versions.
- `catalog()`: `{ boardSize: { values: [6], default: 6 }, handSize: { min: 1, max: 3, default: 3
  }, selfElimination: { values: ["avoidIfPossible", "allowed"], default: "avoidIfPossible" },
  tiles: 35 }`.
- `players(options)` = `{ min: 2, max: 8 }`. No resources. `validateStart` always succeeds.
- `defaultTurnTimeoutDays` = 3 (groups of kids need a quicker pace). The timeout itself is a
  framework setting (02 §4); seat order is the framework's `seatOrder`.
- Module config: none in v1.
- Our own divergences (bigger boards with extra tile copies, team play, special tiles) come later as
  options or new module versions.

## 7. Module contract implementation

- **State** (secret): `{ options, deck (ordered, drawn from the front), hands[seat] (ascending
  tile ids), board[r][c]: { tileId, rotation } | null, markers[seat]: { pos: { r, c, n } | null /*
  null = edge exit, removed, or not placed */, out: { atAction, reason } | null }, phase: "markers" |
  "tiles", turn: Seat | null /* the seat to act; null once over */, moves /* module transitions so
  far */, tokenHolder: Seat | null, endReason: null | "last-standing" | "wipe-out" | "board-full"
  }`. `out.atAction` is the value of `moves` before the transition that put the seat out, so seats
  out in the same transition share it (the elimination order, §5); `out.reason` is `eliminated`,
  `resigned`, `timed_out` or `declined`. Hidden information for `perturbHidden`: the deck order
  and other players' hands.
- **seatStatus**: `out` once a marker is eliminated, or its player resigned, timed out or
  declined.
- **Actions**:
  `{ type: "place-marker", edgeNotch: number /* any integer; 0..8·boardSize−1 is legal, §1 */ }`,
  `{ type: "place-tile", tileId: number /* 0..34 */, rotation: 0 | 1 | 2 | 3 }`.
- **Errors** (`errorCodes`), checked in this order (first failure wins): `NOT_TO_ACT` (`validate`
  for a seat that isn't in `toAct`, which the framework never asks) → `WRONG_PHASE` (action type
  doesn't match the phase) → `OUT_OF_RANGE` (`edgeNotch` outside `0..8·boardSize−1`; every index in
  range is an edge notch, §1) → `NOTCH_OCCUPIED` (place-marker) / `NOT_IN_HAND` (place-tile) →
  `SELF_ELIMINATION_AVOIDABLE`. `SELF_ELIMINATION_AVOIDABLE` is computed only from the board,
  markers and the mover's own hand. None has a `detail`. The option errors are in §6.
- **View**: `{ boardSize, phase, board, markers[seat]: { pos, out }, toAct, deckCount, handCounts,
  yourHand (null for the public view), hands (null while the game is in progress; afterwards
  everyone's remaining hand), tokenHolder, endReason }`, with `board`, `pos` and `out` as in the
  state. History comes from the framework's history endpoint (02 §3), not the view.
- **Record** (`PathsRecord`), one shape per `type`, every one with `{ seat, moves: [{ seat, path: {
  r, c, n }[] }], eliminated: Seat[], collided: Seat[][], skipped: Seat[] }`: `place-marker` adds
  `edgeNotch`; `place-tile` adds `tileId`, `rotation` and `square: { r, c }`; `resign`, `decline`
  and `timeout` add nothing. `moves` lists, in seat order, every marker the tile moved; its `path`
  starts with the marker's position before the move and then gives, for each tile it crossed in
  order, the notch it left that tile by, as `{ r, c, n }` of that tile's square. A marker that
  survives faces the square across the last notch (its new position); one whose last notch is an
  edge notch is out. `eliminated` lists in seat order the markers the move put out; `collided` the
  pairs among them that collided (§3), each pair ascending, pairs in order of their first seat.
  The full movement trace is public, so every client can animate it. Records never mention drawn
  or returned tiles.
- **Preview**: not needed on the server; the client engine computes it locally (§3).
- `describe`: `[{seat:0}, " placed a tile — ", {seat:2}, " and ", {seat:3}, " crashed!"]` (a
  collision; a marker that just ran off the board "ran off the board"); `[{seat:0}, " placed
  their marker"]`; `[{seat:1}, " resigned"]`, `[{seat:1}, " ran out of time"]`; for `decline`:
  `[{seat:1}, " declined the game"]`. `summary`: headline "4 left of 6 · your turn" (or "· ",
  `{seat}`, " to play" for anyone else); once over, `{seat}` " won" for last standing and "Shared
  win" for the other endings.
- **Termination bound** (`maxActions`): `players` (markers) + 35 (tiles) + `players`
  (resigns/timeouts). Skips are not actions.
- **worstCase**: late-game boards where a placement moves every surviving marker along the longest
  available chains. Such boards can't be written down by hand for every seat count, so the hook is
  a heuristic search, not a proof: it plays seeded random games and costs each tile turn's legal
  placements by the tile paths `validate` and `apply` actually trace (the placement once in each,
  plus, under `avoidIfPossible` when it puts the mover out, every tile and rotation in hand). It
  keeps the costliest placement of each of the 4 costliest positions, plus the costliest one that
  puts the mover out if none of those does.

## 8. UI notes (games/paths client)

- Squares are `min(56 pt, (viewport width − 2 × 16 px) / 6)`, so the board fits a 320 px screen
  (48 px squares). The board is as wide as the shell's content column up to `6 × 56 pt`, so the
  page's 16 px gutters give exactly that formula; markers on the board's edge notches hang half
  outside the board, into the gutter.
- **Layout**, top to bottom: the players (marker, name, tiles held or "out"), the turn line, the
  board, a live status line, then the hand and its two buttons, or in the marker phase the notch
  picker. The board owns the players and the turn (02 §3). The page order keeps the board's top
  on the first screen of a 320 px phone.
- Your hand shows below the board. Tap a tile to select it, tap it again (or use the ↻ button) to
  rotate. The target square is always highlighted. A ghost overlay shows the tile and the resulting
  path traces for every marker that would move, with a clear warning when your own marker would be
  eliminated. Then tap **Place**.
  - Each hand tile keeps its own rotation. The preview is the engine's `movement` run on the
    view's public board and the viewer's own marker (§3), so it is exact; a trace is drawn in its
    marker's colour with a dark and a light outline, a surviving marker's end is a hollow marker,
    and a marker that would leave the board ends in a cross.
  - A tile that puts your marker out is also marked on its hand tile (a "✗ out" chip beside the
    tile; "✓ safe" otherwise) and in its accessible name. With `avoidIfPossible`, while some tile
    and rotation in hand keeps your marker on the board, **Place** is disabled for one that
    doesn't, with the line "Another tile or turn keeps your marker on the board, so you can't
    play this one." (the server would refuse it with `SELF_ELIMINATION_AVOIDABLE`); when every
    choice puts you out, **Place** stays enabled and the line says you must play one anyway.
    The warning is words, never only colour.
  - Off turn you may select and turn tiles to plan; the status says the board may change, and
    **Place** is disabled.
  - Keyboard (07 §6): arrow keys choose a hand tile, R turns it, Enter places the chosen tile,
    Space (or a tap on a button) selects and turns, as a tap does.
- Movement animates marker by marker along the traces. With `prefers-reduced-motion`, markers jump
  straight to their end positions.
  - The client finds the move by comparing the new view with the one before: if exactly one tile
    was added, it replays that placement with `movement`, and if the replay's end positions agree
    with the new view's markers it animates the paths (the markers move along the same curves the
    tiles draw). Anything else (several moves at once after a missed update, a resignation, a
    different game) just shows the new positions.
  - A replay takes at most 90 frames of 40 ms in all, one marker after another in seat order; a
    marker that went out stays at the edge until it ends. The status line says what happened ("Ann
    placed a tile. Bo ran off the board.") whether or not the person saw it move.
- **Marker phase** in two steps, because edge notches are too close together to tap: tap an edge
  square, then pick one of its free edge notches from large (≥ 44 pt) buttons. Occupied notches are
  disabled. Picking a notch places the marker (the second step is the action); "Choose another
  square" goes back. The square's notches are drawn on the board, the one a button is focused or
  hovered on larger, and focus moves to the first notch button.
- **Markers** are told apart by shape as well as colour, in the Okabe–Ito colour set, by seat: blue
  circle, orange square, green triangle, pink diamond, sky-blue star, red hexagon, yellow cross, grey
  ring. Each is drawn with a dark and a light outline so it shows on a tile or an empty square of
  either theme. The players list names each marker ("blue circle marker") for screen readers.
- **Accessibility**: every square has an accessible name ("Row 2, column 5, empty, your marker
  faces this square" / "… tile placed"; another player's marker facing it adds "Sam's marker faces
  this square"; an edge square you can pick in the marker phase adds ", choose a notch"); notch
  buttons ("Top edge, left notch, free", "… occupied"); hand tiles and rotations ("Tile 3 of 3,
  rotated 90 degrees; your marker would survive / be eliminated"). Status text is in a polite live
  region that is always in the page.
- **Theme**: the board follows the page's theme like the shell's own screens (07 §5): light by
  default, dark under `prefers-color-scheme: dark` unless the person chose light, and dark when
  they chose dark. Its colours are tokens (custom properties of the board), each theme's contrast
  tested.
- **Finished game**: the shell's result card owns the ranks; the board adds how the game ended and
  the tiles each player still held (`view.hands`).
- Options form: the hand size (1–3) and the self-elimination variant, as radios with plain-language
  descriptions; the board size isn't offered (6 only). The rules sheet states the game's options,
  then the manifest's rules for its version.
- Original art: tiles drawn as SVG from their path data, so no image assets and any theme is easy.
  A tile's four paths are quadratic curves through the square's centre between the notches the
  tile joins; the same curves are the ghost traces and the markers' animation.

## 9. Module-specific tests

The generated tile set has exactly 35 tiles and none is a rotation of another; tile ids match the
canonical ordering. Notch adjacency, the edge-notch formula and rotation maths are tested
exhaustively. Rules tables cover: movement across chains of tiles, moving other players' markers,
head-on collisions (reported as `collided`, both off the board), edge exits, the self-elimination
rule (forced and avoidable cases), deck exhaustion, the token deal and token hand-over when its
holder is out, skipping empty-handed players, resignation returning tiles, and every end condition,
including simultaneous wipe-out and board full.
