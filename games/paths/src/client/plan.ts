/**
 * What a placement will do, and what a new view shows was done: the ghost preview of a tile in
 * hand (paths §3, §8) and the replay of another player's move. Both are the engine's `movement`
 * run on the public board; nothing here knows a rule the engine doesn't. Nothing is authoritative:
 * the server validates every action.
 */
import type { Seat } from "@your-move/sdk";

import {
  livePosition,
  movement,
  type Movement,
  type NotchPosition,
  type Placed,
  type View,
} from "../engine/index.js";
import { hopsOf, pointOf, walk, type Point } from "./layout.js";

/** The square a seat's marker faces: where its next tile goes. */
export function targetOf(view: View, seat: Seat | null): { r: number; c: number } | null {
  const marker = seat === null ? undefined : view.markers[seat];
  const pos = marker === undefined ? null : livePosition(marker);
  return pos === null ? null : { r: pos.r, c: pos.c };
}

/** The preview of one tile at one rotation. */
export interface Preview {
  readonly movement: Movement;
  /** Whether it puts the viewer's own marker off the board. */
  readonly eliminatesYou: boolean;
}

/** Places `placed` on the viewer's target square and moves the markers, as the engine would. */
export function previewPlacement(view: View, seat: Seat, placed: Placed): Preview | null {
  const target = targetOf(view, seat);
  if (target === null || view.phase !== "tiles") return null;
  const result = movement(view.board, view.markers, target, placed);
  return { movement: result, eliminatesYou: result.eliminated.includes(seat) };
}

/** One marker's walk for an animation: the points it passes, in order. */
export interface Walk {
  readonly seat: Seat;
  readonly from: Point;
  readonly points: readonly Point[];
}

/** A move found by comparing two views: who moved, and the engine's account of it. */
export interface Replay {
  readonly mover: Seat | null;
  readonly movement: Movement;
}

/** The tiles `next` has that `prev` doesn't, with their squares. */
function newTiles(prev: View, next: View): { r: number; c: number; placed: Placed }[] | null {
  const found: { r: number; c: number; placed: Placed }[] = [];
  for (const [r, row] of next.board.entries()) {
    for (const [c, placed] of row.entries()) {
      const before = prev.board[r]?.[c] ?? null;
      if (placed === null) {
        if (before !== null) return null;
      } else if (before === null) found.push({ r, c, placed });
      else if (before.tileId !== placed.tileId || before.rotation !== placed.rotation) return null;
    }
  }
  return found;
}

/** Whether two positions are the same (a marker not moving). */
function same(a: NotchPosition | null, b: NotchPosition | null): boolean {
  return a === b || (a !== null && b !== null && a.r === b.r && a.c === b.c && a.n === b.n);
}

/**
 * The single tile placement that turns `prev` into `next`, replayed with the engine, or null when
 * the views don't differ by exactly that (a different game, several moves at once, a resignation):
 * the board then just shows the new positions. The replay's end positions must match `next`'s
 * markers, so a replay that disagrees with the server is dropped, not drawn.
 */
export function replayOf(prev: View, next: View): Replay | null {
  if (prev.phase !== "tiles" || next.phase !== "tiles") return null;
  if (prev.markers.length !== next.markers.length) return null;
  const tiles = newTiles(prev, next);
  if (tiles?.length !== 1) return null;
  const [only] = tiles;
  if (only === undefined) return null;
  const result = movement(prev.board, prev.markers, only, only.placed);
  const moved = new Map(result.moves.map((move, i) => [move.seat, result.ends[i] ?? null]));
  const agrees = next.markers.every((marker, seat) => {
    const was = prev.markers[seat];
    if (was === undefined) return false;
    if (!moved.has(seat)) return same(was.pos, marker.pos);
    const end = moved.get(seat) ?? null;
    return end === null ? marker.out !== null : same(end, marker.pos);
  });
  return agrees ? { mover: prev.toAct[0] ?? null, movement: result } : null;
}

/** Frames of animation a replay may take in all; each is `FRAME_MS` long. */
export const FRAME_BUDGET = 90;
/** Points a marker passes inside one tile path, at most. */
const MAX_STEPS = 6;

/** The time between frames, in milliseconds. */
export const FRAME_MS = 40;

/** `count` of `points`, spread evenly and always ending on the last one. */
function subsample(points: readonly Point[], count: number): Point[] {
  if (points.length <= count) return [...points];
  return Array.from(
    { length: count },
    (_, i) => points[Math.ceil(((i + 1) * points.length) / count) - 1],
  ).flatMap((point) => (point === undefined ? [] : [point]));
}

/**
 * Every moving marker's points, one marker after another (paths §8). Each marker gets an equal
 * share of `FRAME_BUDGET` frames, so a whole replay never exceeds it however long the paths are:
 * a marker with more points than its share is subsampled evenly, keeping its last point.
 */
export function walks(replay: Replay): Walk[] {
  const { moves } = replay.movement;
  const each = Math.floor(FRAME_BUDGET / Math.max(1, moves.length));
  return moves.map((move) => {
    const hops = hopsOf(move.path);
    const steps = Math.max(1, Math.min(MAX_STEPS, Math.floor(each / Math.max(1, hops.length))));
    const start = move.path[0];
    return {
      seat: move.seat,
      from: start === undefined ? { x: 0, y: 0 } : pointOf(start),
      points: subsample(walk(hops, steps), each),
    };
  });
}

/**
 * Where every animated marker is at a frame: markers not yet moving are at their starts, those
 * that have moved on their ends. Frame 0 is the start; the last frame is the end.
 */
export function positionsAt(all: readonly Walk[], frame: number): Map<Seat, Point> {
  const shown = new Map<Seat, Point>();
  let spent = 0;
  for (const one of all) {
    const index = Math.min(one.points.length, Math.max(0, frame - spent));
    shown.set(one.seat, index === 0 ? one.from : (one.points[index - 1] ?? one.from));
    spent += one.points.length;
  }
  return shown;
}

/** How many frames a replay takes. */
export function frameCount(all: readonly Walk[]): number {
  return all.reduce((sum, one) => sum + one.points.length, 0);
}
