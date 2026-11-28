import { seededRandom } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { movement, selfElimination } from "../engine/index.js";
import { view as viewOf } from "../engine/present.js";
import { legalPlacements, validate, freeEdgeNotches } from "../engine/rules.js";
import { placeMarker, placeTile, setup, type State } from "../engine/state.js";
import { facing, game, OPTIONS } from "../test-support.js";
import { targetOf } from "./plan.js";

interface Tally {
  checked: number;
  blocked: number;
  forced: number;
}

/**
 * At every tile turn of a seeded game, asks the engine's rule through what a client has (the
 * viewer's view, the target square its marker faces, its own hand) for every tile and rotation in
 * hand, and compares it with the server's `validate` on the real state.
 */
function check(state: State, tally: Tally): void {
  const seat = state.turn;
  if (seat === null || state.phase !== "tiles") return;
  const view = viewOf(state, seat);
  const target = targetOf(view, seat);
  if (target === null) return;
  const hand = view.yourHand ?? [];
  const avoid = state.options.selfElimination === "avoidIfPossible";
  const legal = legalPlacements(state, seat);
  for (const tileId of hand) {
    for (let rotation = 0; rotation < 4; rotation += 1) {
      const placed = { tileId, rotation };
      const verdict = selfElimination(view.board, view.markers, seat, target, hand, avoid, placed);
      const refused =
        (validate(state, seat, { type: "place-tile", tileId, rotation }) as { code?: string })
          .code === "SELF_ELIMINATION_AVOIDABLE";
      expect(verdict.blocked).toBe(refused);
      // And the engine's separate list of legal placements (its `options()` path) says the same.
      expect(legal.some((one) => one.tileId === tileId && one.rotation === rotation)).toBe(
        !refused,
      );
      tally.checked += 1;
      if (verdict.blocked) tally.blocked += 1;
      if (verdict.safeExists === false) tally.forced += 1;
    }
  }
}

/** Plays a seeded game to its end, checking every tile turn. */
function play(
  seed: number,
  seats: number,
  variant: State["options"]["selfElimination"],
  tally: Tally,
): void {
  const rng = seededRandom(seed);
  let state = setup({ options: { ...OPTIONS, selfElimination: variant }, seats, rng });
  for (let step = 0; step < 200 && state.turn !== null; step += 1) {
    const seat = state.turn;
    if (state.phase === "markers") {
      const free = freeEdgeNotches(state);
      state = placeMarker(state, seat, free[rng.nextInt(free.length)] ?? 0).state;
    } else {
      check(state, tally);
      const legal = legalPlacements(state, seat);
      state = placeTile(
        state,
        seat,
        legal[rng.nextInt(legal.length)] ?? { tileId: 0, rotation: 0 },
        rng,
      ).state;
    }
  }
}

describe("the client's self-elimination rule against the server's validate (paths §3 step 4)", () => {
  it("agrees for every tile and rotation in hand through seeded games, both variants", () => {
    const tally = { checked: 0, blocked: 0, forced: 0 };
    for (let seed = 1; seed <= 40; seed += 1) {
      for (const variant of ["avoidIfPossible", "allowed"] as const) {
        play(seed, 2 + (seed % 3), variant, tally);
      }
    }
    expect(tally.checked).toBeGreaterThan(1000);
    // The sample must reach the rule's cases, or agreeing proves nothing.
    expect(tally.blocked).toBeGreaterThan(0);
  });

  it("agrees when every tile and rotation in hand eliminates the mover", () => {
    const tally = { checked: 0, blocked: 0, forced: 0 };
    for (const variant of ["avoidIfPossible", "allowed"] as const) {
      // Tile 0 joins each notch to its neighbour on the same edge: off the board from the edge.
      check(
        game({
          markers: [facing(0, 2, 0), facing(5, 4, 4)],
          hands: [[0], [20, 21, 22]],
          options: { selfElimination: variant },
        }),
        tally,
      );
    }
    expect(tally.forced).toBeGreaterThan(0);
    expect(tally.blocked).toBe(0);
  });
});

describe("the paths e2e's elimination (A24-P2-3)", () => {
  // paths.spec.ts starts each player in a corner of the board and takes the first free notch the
  // picker lists: the corner's lowest edge notch, so on an empty board these four starts. No start
  // on the board lets every one of the 35 tiles eliminate its marker in some rotation, so the
  // first turn's elimination is not deterministic by construction; the best starts leave 7 tiles
  // that can't, and a hand of three is all of those with probability C(7,3) / C(35,3), about
  // 0.5 %, for one player (the spec then goes on to the next turns, up to eight).
  const STARTS = [
    { r: 0, c: 0, n: 0, cannot: [24, 26, 27, 30, 31, 32, 33] },
    { r: 0, c: 5, n: 0, cannot: [28, 29, 30, 31, 32, 33, 34] },
    { r: 5, c: 5, n: 2, cannot: [28, 29, 30, 31, 32, 33, 34] },
    { r: 5, c: 0, n: 4, cannot: [28, 29, 30, 31, 32, 33, 34] },
  ];

  it.each(
    STARTS.map(
      (start) => [`${String(start.r)},${String(start.c)} notch ${String(start.n)}`, start] as const,
    ),
  )(
    "knows exactly which tiles have no rotation that puts a marker started at %s off the board",
    (_name, start) => {
      const board = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => null));
      const markers = [{ pos: start, out: null }];
      const cannot = Array.from({ length: 35 }, (_, tileId) => tileId).filter(
        (tileId) =>
          ![0, 1, 2, 3].some((rotation) =>
            movement(board, markers, start, { tileId, rotation }).eliminated.includes(0),
          ),
      );
      expect(cannot).toEqual(start.cannot);
      // The other 28 tiles all do.
      expect(35 - cannot.length).toBe(28);
    },
  );
});
