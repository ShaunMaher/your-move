/**
 * Test helpers for the paths package: a source that refuses draws, tiles named by their paths and
 * a state builder for rules tables. Never imported by the engine, client or manifest, and left out
 * of the published files.
 */
import type { GameEnvelope, RandomSource, Seat } from "@your-move/sdk";

import { ascending } from "./engine/at.js";
import type { Marker, Options, Out, Placed, Position } from "./engine/schemas.js";
import type { State } from "./engine/state.js";
import { normalise, rotatePairs, ROTATIONS, TILE_COUNT, TILES, type Pair } from "./engine/tiles.js";

/** A source that must never be drawn from: proves a transition uses no randomness. */
export const noRandom: RandomSource = {
  nextInt() {
    throw new Error("drew a random value");
  },
};

/** The default options. */
export const OPTIONS: Options = { boardSize: 6, handSize: 3, selfElimination: "avoidIfPossible" };

/** Text form of a normalised matching, for comparisons. */
const text = (pairs: readonly Pair[]): string => JSON.stringify(normalise(pairs));

/**
 * The tile and rotation that join exactly these notch pairs once placed, e.g. `[[0, 5], [1, 4],
 * [2, 7], [3, 6]]` for a tile whose paths run straight across.
 */
export function placedFor(pairs: readonly Pair[]): Placed {
  const wanted = text(pairs);
  for (const tile of TILES) {
    for (let rotation = 0; rotation < ROTATIONS; rotation += 1) {
      if (text(rotatePairs(tile.pairs, rotation)) === wanted) return { tileId: tile.id, rotation };
    }
  }
  throw new Error(`no tile joins ${wanted}`);
}

/** Straight across: top to bottom and left to right. */
export const STRAIGHT: readonly Pair[] = [
  [0, 5],
  [1, 4],
  [2, 7],
  [3, 6],
];

/** A live marker on notch `n` of square `(r, c)`, facing that square. */
export const facing = (r: number, c: number, n: number): Marker => ({
  pos: { r, c, n },
  out: null,
});

/** A marker that hasn't been placed yet. */
export const unplaced: Marker = { pos: null, out: null };

/** A seat out at `atAction` for `reason`. */
export const out = (atAction: number, reason: Out["reason"] = "eliminated"): Marker => ({
  pos: null,
  out: { atAction, reason },
});

/** A rules-table state; everything not given takes a neutral value. */
export interface Table {
  readonly markers: readonly Marker[];
  readonly options?: Partial<Options>;
  readonly phase?: State["phase"];
  readonly board?: readonly { readonly r: number; readonly c: number; readonly placed: Placed }[];
  readonly hands?: readonly (readonly number[])[];
  /** The deck, front first; by default every tile not on the board or in a hand, ascending. */
  readonly deck?: readonly number[];
  readonly turn?: Seat | null;
  readonly moves?: number;
  readonly tokenHolder?: Seat | null;
}

/** Builds a state for a rules table. */
export function game(table: Table): State {
  const options = { ...OPTIONS, ...table.options };
  const size = options.boardSize;
  const board: State["board"] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => null),
  );
  for (const { r, c, placed } of table.board ?? []) {
    const row = board[r];
    if (row === undefined) throw new Error("row off the board");
    row[c] = { ...placed };
  }
  const hands = (table.hands ?? table.markers.map(() => [])).map((hand) =>
    [...hand].sort(ascending),
  );
  const used = new Set([
    ...hands.flat(),
    ...board.flatMap((row) => row.flatMap((placed) => (placed === null ? [] : [placed.tileId]))),
  ]);
  const deck =
    table.deck === undefined
      ? Array.from({ length: TILE_COUNT }, (_, id) => id).filter((id) => !used.has(id))
      : [...table.deck];
  return {
    options,
    deck,
    hands,
    board,
    markers: table.markers.map((marker) => ({
      pos: marker.pos && { ...marker.pos },
      out: marker.out && { ...marker.out },
    })),
    phase: table.phase ?? "tiles",
    turn: table.turn === undefined ? 0 : table.turn,
    moves: table.moves ?? 10,
    tokenHolder: table.tokenHolder ?? null,
    endReason: null,
  };
}

/** A position, for readability in expectations. */
export const pos = (r: number, c: number, n: number): Position => ({ r, c, n });

/** A minimal active-game envelope (05 §Common types) with the given display names. */
export function envelope(
  names: readonly (string | null)[],
  yourSeat: number | null,
  fields: Partial<GameEnvelope> = {},
): GameEnvelope {
  return {
    id: "g1",
    gameType: "paths",
    gameVersion: 1,
    options: OPTIONS,
    status: "active",
    version: 3,
    endReason: null,
    turnTimeoutDays: 3,
    seatOrder: "join",
    aiAssistance: "off",
    available: true,
    resources: [],
    players: names.map((displayName, seat) => ({
      seat,
      userId: displayName === null ? null : `u${String(seat)}`,
      displayName,
      kind: "human",
      state: "playing",
      isYou: seat === yourSeat,
      isCreator: seat === 0,
    })),
    yourSeat,
    toAct: [0],
    yourTurn: yourSeat === 0,
    yourInvitation: null,
    createdAt: 0,
    lastActionAt: null,
    ...fields,
  };
}
