/**
 * Movement rules tables (paths §3 steps 2–3, §9): chains of tiles, other players' markers, edge
 * exits and head-on collisions. Tiles are named by the notch pairs they join once placed.
 */
import { describe, expect, it } from "vitest";

import { facing, game, out, placedFor, pos, STRAIGHT, unplaced } from "../test-support.js";
import { movement } from "./movement.js";

describe("movement (paths §3)", () => {
  it("moves a marker across the new tile to face the empty square beyond", () => {
    const state = game({ markers: [facing(0, 0, 0), facing(5, 5, 4)] });
    const moved = movement(state.board, state.markers, { r: 0, c: 0 }, placedFor(STRAIGHT));
    expect(moved).toEqual({
      moves: [{ seat: 0, path: [pos(0, 0, 0), pos(0, 0, 5)] }],
      ends: [pos(1, 0, 0)],
      eliminated: [],
      collided: [],
    });
  });

  it("follows a chain of placed tiles until it faces an empty square", () => {
    const below = placedFor([
      [0, 5],
      [1, 2],
      [3, 4],
      [6, 7],
    ]);
    const state = game({
      markers: [facing(0, 0, 0), unplaced],
      board: [{ r: 1, c: 0, placed: below }],
    });
    const moved = movement(state.board, state.markers, { r: 0, c: 0 }, placedFor(STRAIGHT));
    expect(moved.moves).toEqual([{ seat: 0, path: [pos(0, 0, 0), pos(0, 0, 5), pos(1, 0, 5)] }]);
    expect(moved.ends).toEqual([pos(2, 0, 0)]);
  });

  it("follows a path that leaves the new tile and comes back into it", () => {
    // The marker came in from the left edge across (1, 0); above the new square, (0, 1) turns
    // straight back down, so the trace crosses the new tile twice.
    const left = placedFor([
      [0, 1],
      [2, 7],
      [3, 4],
      [5, 6],
    ]);
    const above = placedFor([
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ]);
    const state = game({
      markers: [facing(1, 1, 7), unplaced],
      board: [
        { r: 1, c: 0, placed: left },
        { r: 0, c: 1, placed: above },
      ],
    });
    const placed = placedFor([
      [0, 7],
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    const moved = movement(state.board, state.markers, { r: 1, c: 1 }, placed);
    expect(moved.moves).toEqual([
      { seat: 0, path: [pos(1, 1, 7), pos(1, 1, 0), pos(0, 1, 4), pos(1, 1, 2)] },
    ]);
    expect(moved.ends).toEqual([pos(1, 2, 7)]);
    expect(moved.eliminated).toEqual([]);
  });

  it("puts out a marker led off the board on an edge notch", () => {
    const state = game({ markers: [facing(0, 0, 0), facing(5, 5, 4)] });
    const placed = placedFor([
      [0, 7],
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    const moved = movement(state.board, state.markers, { r: 0, c: 0 }, placed);
    expect(moved.moves).toEqual([{ seat: 0, path: [pos(0, 0, 0), pos(0, 0, 7)] }]);
    expect(moved.ends).toEqual([null]);
    expect(moved.eliminated).toEqual([0]);
    expect(moved.collided).toEqual([]);
  });

  it("moves every marker facing the square, other players' included, in seat order", () => {
    const state = game({ markers: [facing(5, 5, 4), facing(0, 0, 0), facing(0, 0, 7)], turn: 1 });
    const placed = placedFor([
      [0, 2],
      [1, 5],
      [3, 7],
      [4, 6],
    ]);
    const moved = movement(state.board, state.markers, { r: 0, c: 0 }, placed);
    expect(moved.moves).toEqual([
      { seat: 1, path: [pos(0, 0, 0), pos(0, 0, 2)] },
      { seat: 2, path: [pos(0, 0, 7), pos(0, 0, 3)] },
    ]);
    expect(moved.ends).toEqual([pos(0, 1, 7), pos(0, 1, 6)]);
    expect(moved.eliminated).toEqual([]);
  });

  it("can move another player's marker off the board while the mover survives", () => {
    const state = game({ markers: [facing(0, 0, 0), facing(0, 0, 7)] });
    const placed = placedFor([
      [0, 2],
      [1, 3],
      [4, 5],
      [6, 7],
    ]);
    const moved = movement(state.board, state.markers, { r: 0, c: 0 }, placed);
    expect(moved.eliminated).toEqual([1]);
    expect(moved.ends).toEqual([pos(0, 1, 7), null]);
    expect(moved.collided).toEqual([]);
  });

  it("reports a head-on collision on one tile path: both markers end off the board", () => {
    // Seat 0 came down from the top edge through (0, 0); seat 1 waits on the left edge of (1, 0).
    // The new tile joins their notches, so each follows the other's trail back to its edge.
    const state = game({
      markers: [facing(1, 0, 0), facing(1, 0, 7), facing(5, 5, 4)],
      board: [{ r: 0, c: 0, placed: placedFor(STRAIGHT) }],
    });
    const placed = placedFor([
      [0, 7],
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    const moved = movement(state.board, state.markers, { r: 1, c: 0 }, placed);
    expect(moved).toEqual({
      moves: [
        { seat: 0, path: [pos(1, 0, 0), pos(1, 0, 7)] },
        { seat: 1, path: [pos(1, 0, 7), pos(1, 0, 0), pos(0, 0, 0)] },
      ],
      ends: [null, null],
      eliminated: [0, 1],
      collided: [[0, 1]],
    });
  });

  it("reports two markers sharing an edge pair as a collision too", () => {
    const state = game({ markers: [facing(0, 2, 0), facing(0, 2, 1)] });
    const placed = placedFor([
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ]);
    const moved = movement(state.board, state.markers, { r: 0, c: 2 }, placed);
    expect(moved.eliminated).toEqual([0, 1]);
    expect(moved.collided).toEqual([[0, 1]]);
  });

  it("leaves markers that face other squares, and out or unplaced seats, where they are", () => {
    const state = game({ markers: [facing(0, 0, 0), facing(0, 1, 0), out(3), unplaced] });
    const moved = movement(state.board, state.markers, { r: 0, c: 0 }, placedFor(STRAIGHT));
    expect(moved.moves.map((move) => move.seat)).toEqual([0]);
  });

  it("does not change the board or the markers it is given", () => {
    const state = game({ markers: [facing(0, 0, 0), unplaced] });
    const before = JSON.stringify(state);
    movement(state.board, state.markers, { r: 0, c: 0 }, placedFor(STRAIGHT));
    expect(JSON.stringify(state)).toBe(before);
  });

  it("asserts that two markers never end on the same notch (a state the rules can't reach)", () => {
    const state = game({ markers: [facing(0, 0, 0), facing(1, 0, 0)] });
    expect(() => movement(state.board, state.markers, { r: 0, c: 0 }, placedFor(STRAIGHT))).toThrow(
      /same notch/u,
    );
  });
});
