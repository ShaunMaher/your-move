/**
 * Drawing geometry for the paths board (docs/spec/games/paths.md §1, §8). Everything is in board
 * units: a square is `SQUARE` units wide, so a 6 × 6 board is 576 units across, and the board's
 * SVGs scale it to whatever the screen gives. A notch is a point on a square's edge, a third of
 * the way along it; the path joining two notches of a tile is the quadratic curve between them
 * through the square's centre, and one function draws it and walks along it, so what the board
 * shows and what the markers follow are the same line.
 *
 * Where a marker goes, and what it crosses, is the engine's (`movement`); this module only turns
 * its notch positions into points.
 */
import { across, NOTCHES, partner, type NotchPosition, type Pair } from "../engine/index.js";

/** A square's width in board units; a multiple of 3 so notches sit on whole numbers. */
export const SQUARE = 96;

/** A point of the board's drawing. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Notch `n`'s offset within its square (paths §1: top 0, 1; right 2, 3; bottom 4, 5; left 6, 7). */
const NOTCH_AT: readonly Point[] = [
  { x: 32, y: 0 },
  { x: 64, y: 0 },
  { x: 96, y: 32 },
  { x: 96, y: 64 },
  { x: 64, y: 96 },
  { x: 32, y: 96 },
  { x: 0, y: 64 },
  { x: 0, y: 32 },
];

const CENTRE: Point = { x: SQUARE / 2, y: SQUARE / 2 };

/** Notch `n` of a square, relative to the square's top-left corner. */
export function notchOffset(n: number): Point {
  const offset = NOTCH_AT[n];
  if (offset === undefined) throw new RangeError(`notch ${String(n)} is out of range`);
  return offset;
}

/** The point of a notch on the board (the shared point of the two squares it joins). */
export function pointOf(pos: NotchPosition): Point {
  const offset = notchOffset(pos.n);
  return { x: pos.c * SQUARE + offset.x, y: pos.r * SQUARE + offset.y };
}

/** One tile path as it is travelled: inside square `(r, c)`, from notch `from` to notch `to`. */
export interface Hop {
  readonly r: number;
  readonly c: number;
  readonly from: number;
  readonly to: number;
}

/**
 * The tile paths a movement trace crosses (paths §7 `moves`): the trace starts at the notch the
 * marker faced and then lists, for each tile crossed, the notch it left that tile by. A hop enters
 * its square by the notch the previous one left by (the far side of it: `n XOR 5`), and the first
 * enters by the start notch itself, in the new tile's own square.
 */
export function hopsOf(path: readonly NotchPosition[]): Hop[] {
  const [start, ...exits] = path;
  if (start === undefined) return [];
  let entered = start.n;
  return exits.map((exit) => {
    const hop = { r: exit.r, c: exit.c, from: entered, to: exit.n };
    entered = exit.n ^ 5;
    return hop;
  });
}

/** A hop's three points: where it starts, the square's centre as its control point, where it ends. */
function ends(hop: Hop): [Point, Point, Point] {
  const origin = { x: hop.c * SQUARE, y: hop.r * SQUARE };
  const place = (n: number): Point => {
    const offset = notchOffset(n);
    return { x: origin.x + offset.x, y: origin.y + offset.y };
  };
  return [place(hop.from), { x: origin.x + CENTRE.x, y: origin.y + CENTRE.y }, place(hop.to)];
}

const round = (value: number): string => String(Math.round(value * 100) / 100);

/** SVG path data for a run of hops, one continuous line. */
export function traceD(hops: readonly Hop[]): string {
  return hops
    .map((hop, i) => {
      const [from, control, to] = ends(hop);
      const lead = i === 0 ? `M${round(from.x)} ${round(from.y)} ` : "";
      return `${lead}Q${round(control.x)} ${round(control.y)} ${round(to.x)} ${round(to.y)}`;
    })
    .join(" ");
}

/** The point `t` (0..1) of the way along a hop's curve. */
function along(hop: Hop, t: number): Point {
  const [from, control, to] = ends(hop);
  const u = 1 - t;
  return {
    x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * control.y + t * t * to.y,
  };
}

/** Points along a run of hops after its start, `steps` per hop, ending exactly on the last notch. */
export function walk(hops: readonly Hop[], steps: number): Point[] {
  return hops.flatMap((hop) =>
    Array.from({ length: steps }, (_, i) => along(hop, (i + 1) / steps)),
  );
}

/** SVG path data for one tile path in a tile's own 0..`SQUARE` drawing. */
export function pairD(pair: Pair): string {
  return traceD([{ r: 0, c: 0, from: pair[0], to: pair[1] }]);
}

/** The four paths of a tile at a rotation, as the engine's notch partners give them. */
export function placedPairs(tileId: number, rotation: number): Pair[] {
  const pairs: Pair[] = [];
  for (let n = 0; n < NOTCHES; n += 1) {
    const other = partner(tileId, rotation, n);
    if (n < other) pairs.push([n, other]);
  }
  return pairs;
}

/** Where a movement ends: the point a surviving marker faces, or the edge it left by. */
export function endOf(path: readonly NotchPosition[]): Point | null {
  const last = path[path.length - 1];
  return last === undefined ? null : pointOf(last);
}

/** Whether notch `pos` has a square across it on a board of `size` (else it is an edge notch). */
export function isEdge(size: number, pos: NotchPosition): boolean {
  return across(size, pos) === null;
}

const SIDES = ["Top", "Right", "Bottom", "Left"] as const;
const PLACES = ["left", "right", "upper", "lower", "right", "left", "lower", "upper"] as const;

/** The edge a notch is on, as a player reads it: "Top edge". */
export function edgeName(n: number): string {
  return `${SIDES[Math.floor(n / 2)] ?? ""} edge`;
}

/** The notch's place on its edge as a player reads it: "left", "upper" (paths §1 diagram). */
export function placeName(n: number): string {
  return PLACES[n] ?? "";
}

/** "Top edge, left notch": the notch's name without its state (paths §8). */
export function notchName(n: number): string {
  return `${edgeName(n)}, ${placeName(n)} notch`;
}

/** The notches of square `(r, c)` that are edge notches of a board of `size`, ascending. */
export function edgeNotchesOf(size: number, r: number, c: number): number[] {
  return Array.from({ length: NOTCHES }, (_, n) => n).filter((n) => isEdge(size, { r, c, n }));
}
