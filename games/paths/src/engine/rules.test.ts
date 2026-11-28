/**
 * Validation rules tables (paths §3 step 4, §7 "Errors", §9): the error order and the
 * self-elimination rule, forced and avoidable.
 */
import { OK } from "@your-move/sdk";
import { describe, expect, it } from "vitest";

import { at, game, out, placedFor, STRAIGHT, unplaced } from "../test-support.js";
import { movement } from "./movement.js";
import { freeEdgeNotches, legalPlacements, validate } from "./rules.js";
import type { Action } from "./schemas.js";
import { TILES } from "./tiles.js";

const marker = (edgeNotch: number): Action => ({ type: "place-marker", edgeNotch });
const tile = (tileId: number, rotation = 0): Action => ({ type: "place-tile", tileId, rotation });

/** Tile 0 joins each notch to its neighbour on the same edge at every rotation: always out. */
const KILLER = 0;
/** The straight tile: top to bottom at every rotation, so safe from a top-edge notch. */
const SAFE = placedFor(STRAIGHT).tileId;
/** Joins 0–1 unrotated (out from a top-edge notch) and 0–5 turned once (safe). */
const TURN_ONCE = 5;

describe("validate: the error order (paths §7)", () => {
  const markers = game({ phase: "markers", markers: [at(0, 0, 0), unplaced, unplaced], turn: 1 });
  const tiles = game({ markers: [at(0, 0, 0), at(5, 5, 4)], hands: [[SAFE], [1]] });

  it.each([
    ["a seat that isn't to act", markers, 0, marker(5), "NOT_TO_ACT"],
    ["a seat that isn't to act, even with a wrong action", tiles, 1, marker(-1), "NOT_TO_ACT"],
    ["a game that is over", { ...tiles, turn: null }, 0, tile(SAFE), "NOT_TO_ACT"],
    ["a tile in the marker phase", markers, 1, tile(SAFE), "WRONG_PHASE"],
    ["a marker in the tile phase, before its range", tiles, 0, marker(-1), "WRONG_PHASE"],
    ["an edge notch below the range", markers, 1, marker(-1), "OUT_OF_RANGE"],
    ["an edge notch above the range", markers, 1, marker(48), "OUT_OF_RANGE"],
    ["an edge notch far above the range", markers, 1, marker(1_000_000), "OUT_OF_RANGE"],
    ["an edge notch another marker is on", markers, 1, marker(0), "NOTCH_OCCUPIED"],
    ["a tile not in hand", tiles, 0, tile(1), "NOT_IN_HAND"],
  ])("refuses %s", (_name, state, seat, action, code) => {
    expect(validate(state, seat, action)).toEqual({ code });
  });

  it("accepts any free edge notch in the marker phase, the last one included", () => {
    expect(validate(markers, 1, marker(1))).toEqual(OK);
    expect(validate(markers, 1, marker(47))).toEqual(OK);
    expect(freeEdgeNotches(markers)).toHaveLength(47);
    expect(freeEdgeNotches(markers)).not.toContain(0);
  });

  it("frees the notch of a marker that left the game", () => {
    const left = game({ phase: "markers", markers: [unplaced, out(0, "resigned")], turn: 0 });
    expect(freeEdgeNotches(left)).toHaveLength(48);
  });

  it("accepts a tile in hand at any rotation that keeps the mover on the board", () => {
    for (const rotation of [0, 1, 2, 3])
      expect(validate(tiles, 0, tile(SAFE, rotation))).toEqual(OK);
  });
});

describe("validate: the self-elimination rule (paths §3 step 4)", () => {
  it("refuses a placement that puts the mover out when another tile in hand avoids it", () => {
    const state = game({ markers: [at(0, 2, 0), at(5, 5, 4)], hands: [[KILLER, SAFE], []] });
    expect(validate(state, 0, tile(KILLER))).toEqual({ code: "SELF_ELIMINATION_AVOIDABLE" });
    expect(validate(state, 0, tile(SAFE))).toEqual(OK);
  });

  it("refuses it when another rotation of the same tile avoids it", () => {
    const state = game({ markers: [at(0, 2, 0), at(5, 5, 4)], hands: [[TURN_ONCE], []] });
    expect(validate(state, 0, tile(TURN_ONCE, 0))).toEqual({ code: "SELF_ELIMINATION_AVOIDABLE" });
    expect(validate(state, 0, tile(TURN_ONCE, 1))).toEqual(OK);
    expect(legalPlacements(state, 0).every((placed) => placed.rotation !== 0)).toBe(true);
  });

  it("allows any choice when every tile and rotation in hand puts the mover out", () => {
    // The mover faces the top-left corner square from its top edge; the tiles beside and below it
    // lead every notch they can be entered by straight to the board's edge.
    const beside = placedFor([
      [0, 7],
      [1, 6],
      [2, 3],
      [4, 5],
    ]);
    const below = placedFor([
      [0, 7],
      [1, 6],
      [2, 5],
      [3, 4],
    ]);
    const hand = [SAFE, TURN_ONCE, 20];
    const state = game({
      markers: [at(0, 0, 0), at(5, 5, 4)],
      board: [
        { r: 0, c: 1, placed: beside },
        { r: 1, c: 0, placed: below },
      ],
      hands: [hand, []],
    });
    for (const tileId of hand) {
      for (const rotation of [0, 1, 2, 3])
        expect(validate(state, 0, tile(tileId, rotation))).toEqual(OK);
    }
    expect(legalPlacements(state, 0)).toHaveLength(12);
  });

  it("allows a placement that puts the mover out under the `allowed` variant", () => {
    const state = game({
      options: { selfElimination: "allowed" },
      markers: [at(0, 2, 0), at(5, 5, 4)],
      hands: [[KILLER, SAFE], []],
    });
    expect(validate(state, 0, tile(KILLER))).toEqual(OK);
    expect(legalPlacements(state, 0)).toHaveLength(8);
  });

  it("looks only at the mover's own marker: putting another player out is fine", () => {
    // Seat 1 faces the same square from the left edge. Tile 3 turned once joins 0–5 (seat 0 goes
    // down, onto the board) and 7–1 (seat 1 runs off the top edge).
    const state = game({ markers: [at(0, 0, 0), at(0, 0, 7)], hands: [[3], []] });
    expect(TILES[3]!.pairs).toEqual([
      [0, 1],
      [2, 4],
      [3, 6],
      [5, 7],
    ]);
    expect(
      movement(state.board, state.markers, { r: 0, c: 0 }, { tileId: 3, rotation: 1 }).eliminated,
    ).toEqual([1]);
    expect(validate(state, 0, tile(3, 1))).toEqual(OK);
  });
});
