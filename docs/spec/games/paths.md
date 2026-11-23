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
   (action `place-marker`). The tile phase starts after every player has placed.
4. Each player is dealt `handSize` tiles, in turn order, when the tile phase starts.

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
   `"allowed"`, any choice may be made.
5. **Draw**: if the mover survived, they draw one tile (§4). An eliminated mover doesn't draw.
6. Eliminated players' hand tiles are shuffled back into the deck and dealt out (§4).
7. **Next player**: the next surviving player in turn order who holds at least one tile. Surviving
   players with empty hands are skipped and listed in the record (`skipped`); they are never put in
   `toAct`. If no surviving player holds a tile, the game ends (§5).

The movement result depends only on public information (board, markers) plus the mover's own tile.
So the client computes an exact preview locally: it draws the path the marker(s) would take and
flags eliminations before the player confirms.

## 4. Running out of tiles

- If the deck is empty when a player should draw, they draw nothing. If nobody holds the
  draw-order token, they take it.
- When tiles return to the deck (from eliminated, resigned or timed-out players' hands), they're
  shuffled in and dealt out at once: one at a time in turn order, starting with the token holder (or,
  if nobody holds it, with the next surviving player after the mover), to each surviving player with
  fewer than `handSize` tiles, until every hand is full or the deck is empty.
  - If the deck runs out while someone is still short, the token goes to the next short player in
    turn order after the last player dealt to.
  - Otherwise the token is cleared.
- If the token holder is eliminated, resigns or times out, the token passes to the next surviving
  player in turn order after them who has fewer than `handSize` tiles; if there is none, it's
  cleared.

## 5. End of game

- **Last standing**: when exactly one player remains (not `out`), in either phase, they win
  (rank 1). Other players rank by
  elimination order: the most recently eliminated rank higher, and players eliminated in the same
  move tie (standard competition ranking, 02 §4).
- **Simultaneous wipe-out**: if the last markers are all eliminated in the same move, those players
  share rank 1.
- **Board full**: if no surviving player holds a tile (all tiles are placed or held by nobody — a
  6 × 6 board with 35 tiles leaves one square empty), every remaining player shares rank 1.
- **Resign / timeout**: the player's marker is removed (`out`, reason `resigned` / `timed_out`),
  their hand returns to the deck (§4), and play continues if two or more remain. With one left,
  they win. A player who declines or times out before their first action (placing their marker)
  goes through `onResign(…, "decline")` (02 §2.1 rule 9): the marker and hand are handled the same
  way, but the record has type `decline` and says they declined, never that they resigned; the
  framework records them as `declined` and leaves them out of the ranking (02 §4).
- There are no points; `result()` returns ranks only.

## 6. Options (variants)

```ts
Options = {
  boardSize: 6,                                   // only 6 in v1 (the 35-tile set is sized for it)
  handSize: 3,                                    // 1..3
  selfElimination: "avoidIfPossible" | "allowed",
}
```

- `players(options)` = `{ min: 2, max: 8 }`. No resources. `validateStart` always succeeds.
- `defaultTurnTimeoutDays` = 3 (groups of kids need a quicker pace). The timeout itself is a
  framework setting (02 §4); seat order is the framework's `seatOrder`.
- Module config: none in v1.
- Our own divergences (bigger boards with extra tile copies, team play, special tiles) come later as
  options or new module versions.

## 7. Module contract implementation

- **State** (secret): `{ deck (ordered), hands[seat], board[r][c]: { tileId, rotation } | null,
  markers[seat]: { pos: { r, c, n } | null /* null = edge exit or not placed */, out?: { atAction } },
  phase: "markers" | "tiles", turn, tokenHolder }`. Hidden information for `perturbHidden`: the deck
  order and other players' hands.
- **seatStatus**: `out` once a marker is eliminated, resigned or timed out.
- **Actions**:
  `{ type: "place-marker", edgeNotch: number /* 0..8·boardSize−1, §1 */ }`,
  `{ type: "place-tile", tileId: number, rotation: 0 | 1 | 2 | 3 }`.
- **Errors** (`errorCodes`), checked in this order (first failure wins): `WRONG_PHASE` (action type
  doesn't match the phase) → `OUT_OF_RANGE` (`edgeNotch` outside `0..8·boardSize−1`; every index in
  range is an edge notch, §1) → `NOTCH_OCCUPIED` (place-marker) / `NOT_IN_HAND` (place-tile) →
  `SELF_ELIMINATION_AVOIDABLE`. `SELF_ELIMINATION_AVOIDABLE` is computed only from the board,
  markers and the mover's own hand.
- **View**: board, all markers (positions, out status and reasons), phase, `toAct`, `deckCount`,
  `handCounts`, `yourHand` (null for the public view), `tokenHolder`. History comes from the
  framework's history endpoint (02 §3), not the view. After the game ends: everyone's remaining hand.
- **Record** (`PathsRecord`): `{ seat, type: "place-marker" | "place-tile" | "resign" | "decline" | "timeout",
  tileId?, rotation?, square?, moves: [{ seat, path: { r, c, n }[] }], eliminated: Seat[],
  collided: Seat[][], skipped: Seat[] }`. The full movement trace is public, so every client can
  animate it. Records never mention drawn or returned tiles.
- **Preview**: not needed on the server; the client engine computes it locally (§3).
- `describe`: `[{seat:0}, " placed a tile — ", {seat:2}, " and ", {seat:3}, " crashed!"]`; for
  `decline`: `[{seat:1}, " declined the game"]`;
  `summary`: headline "4 left of 6 · your turn".
- **Termination bound** (`maxActions`): `players` (markers) + 35 (tiles) + `players`
  (resigns/timeouts). Skips are not actions.
- **worstCase**: late-game boards where a placement moves every surviving marker along the longest
  available chains.

## 8. UI notes (games/paths client)

- Squares are `min(56 pt, (viewport width − 2 × 16 px) / 6)`, so the board fits a 320 px screen
  (48 px squares).
- Your hand shows below the board. Tap a tile to select it, tap it again (or use the ↻ button) to
  rotate. The target square is always highlighted. A ghost overlay shows the tile and the resulting
  path traces for every marker that would move, with a clear warning when your own marker would be
  eliminated. Then tap **Place**.
- Movement animates marker by marker along the traces. With `prefers-reduced-motion`, markers jump
  straight to their end positions.
- **Marker phase** in two steps, because edge notches are too close together to tap: tap an edge
  square, then pick one of its free edge notches from large (≥ 44 pt) buttons. Occupied notches are
  disabled.
- **Accessibility**: every square has an accessible name ("Row 2, column 5, empty, your marker
  faces this square" / "… tile placed"); notch buttons ("Top edge, left notch, free"); hand tiles
  and rotations ("Tile 3 of 3, rotated 90 degrees; your marker would survive / be eliminated").
- Original art: tiles drawn as SVG from their path data, so no image assets and any theme is easy.

## 9. Module-specific tests

The generated tile set has exactly 35 tiles and none is a rotation of another; tile ids match the
canonical ordering. Notch adjacency, the edge-notch formula and rotation maths are tested
exhaustively. Rules tables cover: movement across chains of tiles, moving other players' markers,
head-on collisions (reported as `collided`, both off the board), edge exits, the self-elimination
rule (forced and avoidable cases), deck exhaustion, the token deal and token hand-over when its
holder is out, skipping empty-handed players, resignation returning tiles, and every end condition,
including simultaneous wipe-out and board full.
