/**
 * Board geometry (docs/spec/games/paths.md §1): notches, adjacency and the edge-notch index.
 *
 * Each square has 8 notches, numbered 0–7 clockwise from the left notch of the top edge: top 0, 1;
 * right 2, 3; bottom 4, 5; left 6, 7. Notch `n` of a square touches notch `n XOR 5` of the
 * neighbouring square across that edge.
 */
import { at } from "./at.js";

/** Notches per square (and per tile). */
export const NOTCHES = 8;

/** A notch of a square: the square's row and column, and the notch number 0–7. */
export interface NotchPosition {
  readonly r: number;
  readonly c: number;
  readonly n: number;
}

/** Row and column steps to the neighbour across each edge: top, right, bottom, left. */
const STEPS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
];

/** Whether `(r, c)` is a square of a `size × size` board. */
export function onBoard(size: number, r: number, c: number): boolean {
  return r >= 0 && r < size && c >= 0 && c < size;
}

/**
 * The notch on the far side of notch `n` of square `(r, c)`: notch `n XOR 5` of the neighbouring
 * square, or null when `n` is an edge notch (no square there).
 */
export function across(size: number, pos: NotchPosition): NotchPosition | null {
  const [dr, dc] = at(STEPS, Math.floor(pos.n / 2));
  const r = pos.r + dr;
  const c = pos.c + dc;
  return onBoard(size, r, c) ? { r, c, n: pos.n ^ 5 } : null;
}

/** How many edge notches a `size × size` board has: 2 per square along each of its 4 sides. */
export function edgeNotchCount(size: number): number {
  return 8 * size;
}

/**
 * The square and notch of edge notch `e` (`0..8·size−1`), numbered clockwise from the top-left
 * corner of the board (paths §1).
 */
export function edgeNotch(size: number, e: number): NotchPosition {
  if (!Number.isInteger(e) || e < 0 || e >= edgeNotchCount(size)) {
    throw new RangeError(`edge notch ${String(e)} is out of range`);
  }
  const side = Math.floor(e / (2 * size));
  const offset = e - side * 2 * size;
  const k = Math.floor(offset / 2);
  const j = offset % 2;
  const last = size - 1;
  switch (side) {
    case 0:
      return { r: 0, c: k, n: j };
    case 1:
      return { r: k, c: last, n: 2 + j };
    case 2:
      return { r: last, c: last - k, n: 4 + j };
    default:
      return { r: last - k, c: 0, n: 6 + j };
  }
}

/** Whether two notch positions are the same notch of the same square. */
export function samePosition(a: NotchPosition, b: NotchPosition): boolean {
  return a.r === b.r && a.c === b.c && a.n === b.n;
}
