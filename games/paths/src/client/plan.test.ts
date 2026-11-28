import { seededRandom } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { view as viewOf } from "../engine/present.js";
import { placeTile } from "../engine/state.js";
import { facing, game, noRandom, out, placedFor, STRAIGHT } from "../test-support.js";
import {
  frameCount,
  positionsAt,
  previewPlacement,
  replayOf,
  selfEliminationBlocked,
  targetOf,
  walks,
} from "./plan.js";

/** Joins each notch to its neighbour on the same edge: off the board from any edge notch. */
const KILLER = { tileId: 0, rotation: 0 };
const SAFE = placedFor(STRAIGHT);

/** Ann at the top edge, left notch of (0, 2); Bo on the bottom edge far away. */
function table(hand: number[], options?: { selfElimination: "allowed" }) {
  return game({
    markers: [facing(0, 2, 0), facing(5, 4, 4)],
    hands: [hand, [20, 21, 22]],
    ...(options === undefined ? {} : { options }),
  });
}

describe("the target and the preview", () => {
  it("is the square the viewer's marker faces, once placed and while in", () => {
    const view = viewOf(table([KILLER.tileId]), 0);
    expect(targetOf(view, 0)).toEqual({ r: 0, c: 2 });
    expect(targetOf(view, null)).toBeNull();
    const gone = viewOf(game({ markers: [out(3), facing(5, 4, 4)] }), 0);
    expect(targetOf(gone, 0)).toBeNull();
  });

  it("is the engine's movement: a tile that sends the viewer's marker off the board says so", () => {
    const view = viewOf(table([KILLER.tileId, SAFE.tileId]), 0);
    const bad = previewPlacement(view, 0, KILLER);
    expect(bad?.eliminatesYou).toBe(true);
    expect(bad?.movement.eliminated).toEqual([0]);
    const good = previewPlacement(view, 0, SAFE);
    expect(good?.eliminatesYou).toBe(false);
    expect(good?.movement.ends[0]).toEqual({ r: 1, c: 2, n: 0 });
  });

  it("has no preview in the marker phase or without a marker", () => {
    const early = viewOf(
      game({ markers: [facing(0, 2, 0), facing(5, 4, 4)], phase: "markers" }),
      0,
    );
    expect(previewPlacement(early, 0, SAFE)).toBeNull();
    const gone = viewOf(game({ markers: [out(3), facing(5, 4, 4)] }), 0);
    expect(previewPlacement(gone, 0, SAFE)).toBeNull();
  });
});

describe("the self-elimination rule (paths §3 step 4)", () => {
  it("blocks a placement that puts the viewer out while another choice keeps them in", () => {
    const view = viewOf(table([KILLER.tileId, SAFE.tileId]), 0);
    const bad = previewPlacement(view, 0, KILLER);
    if (bad === null) throw new Error("no preview");
    expect(selfEliminationBlocked(view, 0, true, bad)).toEqual({ blocked: true, safeExists: true });
    expect(selfEliminationBlocked(view, 0, false, bad)).toEqual({
      blocked: false,
      safeExists: true,
    });
  });

  it("lets the viewer play on when every choice puts them out, and never blocks a safe one", () => {
    const view = viewOf(table([KILLER.tileId]), 0);
    const bad = previewPlacement(view, 0, KILLER);
    if (bad === null) throw new Error("no preview");
    expect(selfEliminationBlocked(view, 0, true, bad)).toEqual({
      blocked: false,
      safeExists: false,
    });
    const view2 = viewOf(table([SAFE.tileId]), 0);
    const good = previewPlacement(view2, 0, SAFE);
    if (good === null) throw new Error("no preview");
    expect(selfEliminationBlocked(view2, 0, true, good).blocked).toBe(false);
  });

  it("agrees with the engine's own validation", () => {
    const state = table([KILLER.tileId, SAFE.tileId]);
    const view = viewOf(state, 0);
    for (const placed of [KILLER, SAFE]) {
      const preview = previewPlacement(view, 0, placed);
      if (preview === null) throw new Error("no preview");
      const verdict = selfEliminationBlocked(view, 0, true, preview);
      // The two tiles with all rotations: the one blocked here is refused there.
      expect(verdict.blocked).toBe(preview.eliminatesYou);
    }
  });
});

describe("replaying a move from two views", () => {
  const before = table([SAFE.tileId, 5, 6]);
  const after = placeTile(before, 0, SAFE, noRandom).state;

  it("finds the one tile that was placed and replays it with the engine", () => {
    const replay = replayOf(viewOf(before, 1), viewOf(after, 1));
    expect(replay?.mover).toBe(0);
    expect(replay?.movement.moves.map((move) => move.seat)).toEqual([0]);
    expect(replay?.movement.ends[0]).toEqual({ r: 1, c: 2, n: 0 });
  });

  it("replays a move that put someone out", () => {
    const killer = table([KILLER.tileId]);
    const done = placeTile(killer, 0, KILLER, seededRandom(1)).state;
    const replay = replayOf(viewOf(killer, 1), viewOf(done, 1));
    expect(replay?.movement.eliminated).toEqual([0]);
  });

  it("gives up when the views don't differ by exactly one placement", () => {
    const view = viewOf(before, 1);
    expect(replayOf(view, view)).toBeNull();
    // Two tiles at once (a missed update).
    const twice = placeTile(after, 1, SAFE, noRandom).state;
    expect(replayOf(view, viewOf(twice, 1))).toBeNull();
    // A tile that changed.
    const changed = viewOf(after, 1);
    const other = {
      ...changed,
      board: changed.board.map((row) =>
        row.map((p) => p && { ...p, rotation: (p.rotation + 1) % 4 }),
      ),
    };
    expect(replayOf(changed, other)).toBeNull();
    // A tile that vanished.
    expect(replayOf(changed, view)).toBeNull();
    // The marker phase has no moves to replay.
    const early = viewOf(
      game({ markers: [facing(0, 2, 0), facing(5, 4, 4)], phase: "markers" }),
      1,
    );
    expect(replayOf(early, view)).toBeNull();
    expect(replayOf(view, early)).toBeNull();
  });

  it("gives up when the replay disagrees with the new view's markers", () => {
    const next = viewOf(after, 1);
    const wrong = {
      ...next,
      markers: next.markers.map((marker, seat) =>
        seat === 0 ? { ...marker, pos: { r: 3, c: 3, n: 0 } } : marker,
      ),
    };
    expect(replayOf(viewOf(before, 1), wrong)).toBeNull();
    const survived = {
      ...next,
      markers: next.markers.map((marker, seat) =>
        seat === 1 ? { ...marker, pos: { r: 3, c: 3, n: 0 } } : marker,
      ),
    };
    expect(replayOf(viewOf(before, 1), survived)).toBeNull();
    const gone = {
      ...next,
      markers: next.markers.map((m, seat) =>
        seat === 0 ? { pos: null, out: { atAction: 1, reason: "eliminated" as const } } : m,
      ),
    };
    expect(replayOf(viewOf(before, 1), gone)).toBeNull();
    const fewer = { ...next, markers: next.markers.slice(0, 1) };
    expect(replayOf(viewOf(before, 1), fewer)).toBeNull();
  });
});

describe("animation frames", () => {
  const before = table([SAFE.tileId, 5, 6]);
  const after = placeTile(before, 0, SAFE, noRandom).state;
  const replay = replayOf(viewOf(before, 1), viewOf(after, 1));
  if (replay === null) throw new Error("no replay");

  it("walks one marker after another, from its start to its end", () => {
    const all = walks(replay);
    expect(all).toHaveLength(1);
    const total = frameCount(all);
    expect(total).toBeGreaterThan(0);
    expect(positionsAt(all, 0).get(0)).toEqual(all[0]?.from);
    expect(positionsAt(all, total).get(0)).toEqual({ x: 224, y: 96 + 0 });
    expect(positionsAt(all, total + 10).get(0)).toEqual(positionsAt(all, total).get(0));
    expect(positionsAt(all, -3).get(0)).toEqual(all[0]?.from);
  });

  it("moves markers in turn: the second waits at its start until the first has finished", () => {
    // Both markers face (0, 0), on notches 0 and 1; a straight tile sends them down together.
    const two = game({
      markers: [facing(0, 0, 0), facing(0, 0, 1)],
      hands: [[SAFE.tileId], [5]],
    });
    const next = placeTile(two, 0, SAFE, noRandom).state;
    const both = replayOf(viewOf(two, 0), viewOf(next, 0));
    if (both === null) throw new Error("no replay");
    const all = walks(both);
    expect(all.map((one) => one.seat)).toEqual([0, 1]);
    const first = all[0]?.points.length ?? 0;
    const middle = positionsAt(all, Math.floor(first / 2));
    expect(middle.get(1)).toEqual(all[1]?.from);
    const done = positionsAt(all, first);
    expect(done.get(0)).toEqual(all[0]?.points[first - 1]);
    expect(done.get(1)).toEqual(all[1]?.from);
  });

  it("keeps every replay within its frame budget", () => {
    expect(frameCount(walks(replay))).toBeLessThanOrEqual(90);
  });
});
