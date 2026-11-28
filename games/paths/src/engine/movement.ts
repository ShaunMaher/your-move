/**
 * Movement (docs/spec/games/paths.md §3 steps 2–3): what placing a tile does to the markers.
 *
 * Everything here depends only on public information (the board and the markers) and the tile
 * placed, so the client can compute the same result locally as an exact preview (paths §3).
 */
import type { Seat } from "@your-move/sdk";

import { at } from "./at.js";
import { across, samePosition, type NotchPosition } from "./geometry.js";
import type { Marker, Move, Placed } from "./schemas.js";
import { partner, ROTATIONS } from "./tiles.js";

/** The board: `board[r][c]` is the tile placed on square `(r, c)`, or null. */
export type Board = readonly (readonly (Placed | null)[])[];

/** A square of the board. */
export interface Square {
  readonly r: number;
  readonly c: number;
}

/** What a placement does: every moved marker's trace and end, who is out and who collided. */
export interface Movement {
  /** The markers that moved, in seat order, with their traces (paths §7 `moves`). */
  readonly moves: Move[];
  /** Where each moved marker ends, in the order of `moves`: the notch it faces, or null if out. */
  readonly ends: (NotchPosition | null)[];
  /** The markers the placement puts out, in seat order. */
  readonly eliminated: Seat[];
  /** The pairs among them that travelled one tile path in opposite directions, ascending. */
  readonly collided: [Seat, Seat][];
}

/**
 * A live marker's position (the notch of the empty square it faces), or null for a marker that is
 * out or not placed yet.
 */
export function livePosition(marker: Marker): NotchPosition | null {
  return marker.out === null ? marker.pos : null;
}

/** A key for one tile path travelled in one direction. */
function stepKey(r: number, c: number, from: number, to: number): string {
  return `${String(r)},${String(c)}:${String(from)}>${String(to)}`;
}

interface Trace {
  readonly path: NotchPosition[];
  readonly end: NotchPosition | null;
  /** Every tile path travelled, as `stepKey`s. */
  readonly steps: string[];
  /** The same paths travelled the other way. */
  readonly reversed: string[];
}

/**
 * Follows the paths from `start` (a notch of the square the new tile is on) until the marker
 * faces an empty square or leaves the board.
 */
function trace(
  size: number,
  tileAt: (r: number, c: number) => Placed | null,
  start: NotchPosition,
): Trace {
  const path: NotchPosition[] = [start];
  const steps: string[] = [];
  const reversed: string[] = [];
  let pos = start;
  // Every tile path is travelled at most once, so a trace crosses at most 4 paths per square.
  const limit = size * size * (ROTATIONS * 2) + 1;
  for (let step = 0; step < limit; step += 1) {
    const tile = tileAt(pos.r, pos.c);
    if (tile === null) return { path, end: pos, steps, reversed };
    const exit = partner(tile.tileId, tile.rotation, pos.n);
    steps.push(stepKey(pos.r, pos.c, pos.n, exit));
    reversed.push(stepKey(pos.r, pos.c, exit, pos.n));
    const leave = { r: pos.r, c: pos.c, n: exit };
    path.push(leave);
    const next = across(size, leave);
    if (next === null) return { path, end: null, steps, reversed };
    pos = next;
  }
  throw new Error("movement: a trace did not end");
}

/**
 * Places `placed` on `square` (which must be empty) and moves every live marker facing it
 * (paths §3 steps 2–3). Pure: `board` and `markers` are not changed. Throws if two markers would
 * end on the same notch, which the rules make impossible (paths §3).
 */
export function movement(
  board: Board,
  markers: readonly Marker[],
  square: Square,
  placed: Placed,
): Movement {
  const size = board.length;
  const tileAt = (r: number, c: number): Placed | null =>
    r === square.r && c === square.c ? placed : at(at(board, r), c);
  const movers: { seat: Seat; trace: Trace }[] = [];
  markers.forEach((marker, seat) => {
    const pos = livePosition(marker);
    if (pos?.r === square.r && pos.c === square.c) {
      movers.push({ seat, trace: trace(size, tileAt, pos) });
    }
  });
  const collided: [Seat, Seat][] = [];
  movers.forEach((first, i) => {
    const opposite = new Set(first.trace.reversed);
    for (const second of movers.slice(i + 1)) {
      if (second.trace.steps.some((step) => opposite.has(step))) {
        collided.push([first.seat, second.seat]);
      }
    }
  });
  const result: Movement = {
    moves: movers.map(({ seat, trace: { path } }) => ({ seat, path })),
    ends: movers.map(({ trace: { end } }) => end),
    eliminated: movers.filter(({ trace: { end } }) => end === null).map(({ seat }) => seat),
    collided,
  };
  assertDistinctEnds(markers, result);
  return result;
}

/** Two markers can never end on the same notch (paths §3); an engine bug if they do. */
function assertDistinctEnds(markers: readonly Marker[], result: Movement): void {
  const moved = new Set(result.moves.map(({ seat }) => seat));
  const positions: NotchPosition[] = [];
  markers.forEach((marker, seat) => {
    const pos = livePosition(marker);
    if (pos !== null && !moved.has(seat)) positions.push(pos);
  });
  for (const end of result.ends) if (end !== null) positions.push(end);
  positions.forEach((pos, i) => {
    if (positions.slice(i + 1).some((other) => samePosition(pos, other))) {
      throw new Error("movement: two markers would end on the same notch");
    }
  });
}
