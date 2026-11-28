import { recordRandom, type Seat } from "@your-move/sdk";
import { seededRandom } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { allMatchedBut, flipAt, game, noRandom } from "../test-support.js";
import { pairsV1 as def } from "./definition.js";
import { GRIDS } from "./schemas.js";
import type { State } from "./state.js";

/** Applies flips of card indexes by the seat to act, in order. */
function flips(state: State, ...cards: number[]): State {
  let next = state;
  for (const card of cards) {
    if (next.turn === null) throw new Error("the game is over");
    next = def.apply(next, next.turn, flipAt(card), noRandom).state;
  }
  return next;
}

const resign = (state: State, seat: Seat): State =>
  def.onResign(state, seat, noRandom, "resign").state;

describe("setup (pairs §2)", () => {
  it.each(GRIDS)("lays out $id: $pairs pairs on $columns × $rows cards", (grid) => {
    for (const seed of [1, 2, 3]) {
      const state = def.setup({ options: { grid: grid.id }, seats: 3, rng: seededRandom(seed) });
      expect(state.faces).toHaveLength(grid.columns * grid.rows);
      const counts = new Map<number, number>();
      for (const face of state.faces) counts.set(face, (counts.get(face) ?? 0) + 1);
      expect(counts.size).toBe(grid.pairs);
      for (const [face, count] of counts) {
        expect(count).toBe(2);
        expect(face).toBeGreaterThanOrEqual(0);
        expect(face).toBeLessThan(18);
      }
      expect(state).toEqual({
        options: { grid: grid.id },
        faces: state.faces,
        matchedBy: state.faces.map(() => null),
        turned: null,
        lastMiss: null,
        turn: 0,
        out: [null, null, null],
        moves: 0,
        endReason: null,
      });
      expect(Object.keys(state)).toEqual([
        "options",
        "faces",
        "matchedBy",
        "turned",
        "lastMiss",
        "turn",
        "out",
        "moves",
        "endReason",
      ]);
    }
  });

  it("puts all 18 faces in play on 6 × 6", () => {
    const state = def.setup({ options: { grid: "6x6" }, seats: 2, rng: seededRandom(4) });
    expect(new Set(state.faces)).toEqual(new Set(Array.from({ length: 18 }, (_, id) => id)));
  });

  it.each(GRIDS)(
    "shuffles all 18 ids on $id, then shuffles the ascending deck of the faces kept",
    (grid) => {
      // A recorded run, replayed by hand: the draws of an 18-card Fisher–Yates shuffle (17 draws)
      // come first on every grid, then those of the deck's (cards − 1 draws).
      const recording = recordRandom(seededRandom(5));
      const state = def.setup({ options: { grid: grid.id }, seats: 2, rng: recording.rng });
      const cards = grid.columns * grid.rows;
      expect(recording.draws).toHaveLength(17 + cards - 1);
      const draws = [...recording.draws];
      const shuffle = (items: number[]): number[] => {
        const result = [...items];
        for (let i = result.length - 1; i > 0; i -= 1) {
          const j = draws.shift() ?? 0;
          [result[i], result[j]] = [result[j] ?? 0, result[i] ?? 0];
        }
        return result;
      };
      const kept = shuffle(Array.from({ length: 18 }, (_, id) => id))
        .slice(0, grid.pairs)
        .sort((a, b) => a - b);
      expect(state.faces).toEqual(shuffle(kept.flatMap((face) => [face, face])));
    },
  );

  it("gives the same layout and faces for the same seed, and others for other seeds", () => {
    const at = (seed: number) =>
      def.setup({ options: { grid: "5x6" }, seats: 2, rng: seededRandom(seed) }).faces;
    expect(at(7)).toEqual(at(7));
    expect(at(7)).not.toEqual(at(8));
  });
});

describe("a turn (pairs §3, §8.2)", () => {
  it("turns a first card up, clears a shown missed pair and keeps the seat to act", () => {
    const before = game({ lastMiss: { seat: 1, cards: [4, 6] }, moves: 7 });
    const { state, record } = def.apply(before, 0, flipAt(8), noRandom);
    expect(record).toEqual({ type: "flip", seat: 0, step: 1 });
    expect(state).toMatchObject({ turned: 8, lastMiss: null, turn: 0, moves: 8 });
    expect(def.toAct(state)).toEqual([0]);
    expect(before.lastMiss).toEqual({ seat: 1, cards: [4, 6] });
  });

  it("scores a match for the seat and keeps the turn", () => {
    const { state, record } = def.apply(game({ turned: 2 }), 0, flipAt(3), noRandom);
    expect(record).toEqual({ type: "flip", seat: 0, step: 2 });
    expect(state.matchedBy.slice(0, 4)).toEqual([null, null, 0, 0]);
    expect(state).toMatchObject({ turned: null, lastMiss: null, turn: 0, endReason: null });
  });

  it("shows a miss and passes the turn to the next seat", () => {
    const { state, record } = def.apply(game({ seats: 3, turned: 2 }), 0, flipAt(5), noRandom);
    expect(record).toEqual({ type: "flip", seat: 0, step: 2 });
    expect(state).toMatchObject({ turned: null, lastMiss: { seat: 0, cards: [2, 5] }, turn: 1 });
    expect(state.matchedBy.every((by) => by === null)).toBe(true);
  });

  it.each([
    // [seats, out, seat to act, next]
    [3, [null, null, null], 2, 0],
    [4, [null, { atMove: 1, reason: "resigned" }, null, null], 0, 2],
    [4, [null, null, { atMove: 1, reason: "timed_out" }, { atMove: 2, reason: "declined" }], 1, 0],
    [5, [{ atMove: 0, reason: "declined" }, null, null, null, null], 4, 1],
  ] as const)(
    "passes the turn after a miss at %i seats, skipping seats out and wrapping",
    (seats, out, seat, next) => {
      const before = game({ seats, out, turn: seat, turned: 0 });
      const { state } = def.apply(before, seat, flipAt(2), noRandom);
      expect(state.turn).toBe(next);
    },
  );

  it("takes a missed card as a first card; the other one goes face down", () => {
    const before = game({ lastMiss: { seat: 1, cards: [4, 6] } });
    expect(def.validate(before, 0, flipAt(4), {})).toEqual({ ok: true });
    const state = flips(before, 4);
    expect(state).toMatchObject({ turned: 4, lastMiss: null });
    // Its partner (card 5) matches it.
    expect(flips(state, 5).matchedBy[4]).toBe(0);
  });

  it("ends the game all-found on the last pair", () => {
    const before = game({ seats: 3 });
    const state = flips(
      game({ seats: 3, matched: allMatchedBut(before, [8, 9], 1), turn: 2 }),
      8,
      9,
    );
    expect(state).toMatchObject({
      endReason: "all-found",
      turn: null,
      turned: null,
      lastMiss: null,
    });
    expect(def.toAct(state)).toEqual([]);
    expect(def.result(state)).toEqual({
      endReason: "all-found",
      ranking: [
        { seat: 1, rank: 1, score: 9 },
        { seat: 2, rank: 2, score: 1 },
        { seat: 0, rank: 3, score: 0 },
      ],
    });
  });

  it("never draws randomness in a transition", () => {
    const state = game({ seats: 3, lastMiss: { seat: 1, cards: [4, 6] } });
    expect(() => flips(state, 0, 1, 2, 5)).not.toThrow();
    expect(() => def.onResign(state, 1, noRandom, "decline")).not.toThrow();
    expect(() => def.onTimeout(state, 0, noRandom)).not.toThrow();
  });
});

describe("the move limit (pairs §6)", () => {
  // 4 × 5: the limit is 400; each table puts the transition under test at move 400.
  const LIMIT = 400;

  it("ends the game at a miss, a match or a leave by the seat to act at the limit", () => {
    const miss = def.apply(game({ turned: 0, moves: LIMIT - 1 }), 0, flipAt(2), noRandom).state;
    expect(miss).toMatchObject({
      endReason: "move-limit",
      turn: null,
      lastMiss: null,
      moves: LIMIT,
    });
    const match = def.apply(game({ turned: 0, moves: LIMIT - 1 }), 0, flipAt(1), noRandom).state;
    expect(match).toMatchObject({ endReason: "move-limit", turn: null, moves: LIMIT });
    expect(match.matchedBy.slice(0, 2)).toEqual([0, 0]);
    const leave = resign(game({ seats: 3, turned: 0, moves: LIMIT - 1 }), 0);
    expect(leave).toMatchObject({ endReason: "move-limit", turn: null, turned: null });
    // Past the limit (a first card or another seat's leave reached it first) counts too.
    const past = def.apply(game({ turned: 0, moves: LIMIT + 2 }), 0, flipAt(2), noRandom).state;
    expect(past.endReason).toBe("move-limit");
  });

  it("doesn't end the game at a first card, nor at a leave by another seat", () => {
    const first = def.apply(game({ moves: LIMIT - 1 }), 0, flipAt(0), noRandom).state;
    expect(first).toMatchObject({ endReason: null, turned: 0, moves: LIMIT });
    const other = resign(game({ seats: 3, turned: 0, moves: LIMIT - 1 }), 2);
    expect(other).toMatchObject({ endReason: null, turn: 0, turned: 0, moves: LIMIT });
    // Just under the limit, a miss passes the turn as usual.
    const under = def.apply(game({ turned: 0, moves: LIMIT - 2 }), 0, flipAt(2), noRandom).state;
    expect(under).toMatchObject({ endReason: null, turn: 1 });
  });

  it("gives all-found and last-standing precedence", () => {
    const before = game();
    const last = game({ matched: allMatchedBut(before, [0, 1]), turned: 0, moves: LIMIT - 1 });
    expect(def.apply(last, 0, flipAt(1), noRandom).state.endReason).toBe("all-found");
    const alone = resign(game({ turned: 0, moves: LIMIT - 1 }), 0);
    expect(alone.endReason).toBe("last-standing");
  });

  it("ranks exactly as all-found", () => {
    const before = game({
      seats: 4,
      matched: [
        [0, 2],
        [1, 2],
        [2, 3],
        [3, 3],
        [4, 0],
        [5, 0],
        [6, 0],
        [7, 0],
      ],
      out: [null, { atMove: 3, reason: "resigned" }, null, null],
      turn: 3,
      turned: 8,
      moves: LIMIT - 1,
    });
    const state = def.apply(before, 3, flipAt(10), noRandom).state;
    expect(def.result(state)).toEqual({
      endReason: "move-limit",
      ranking: [
        { seat: 0, rank: 1, score: 2 },
        { seat: 2, rank: 2, score: 1 },
        { seat: 3, rank: 2, score: 1 },
        { seat: 1, rank: 4, score: 0 },
      ],
    });
  });
});

describe("leaving the game (pairs §5)", () => {
  it.each([
    ["resign", "resigned"],
    ["decline", "declined"],
  ] as const)("maps onResign(%s) to %s, and onTimeout to timed_out", (reason, out) => {
    const before = game({ seats: 3, moves: 5 });
    const { state, record } = def.onResign(before, 1, noRandom, reason);
    expect(record).toEqual({ type: reason, seat: 1 });
    expect(state.out[1]).toEqual({ atMove: 5, reason: out });
    expect(state.moves).toBe(6);
    const timeout = def.onTimeout(before, 0, noRandom);
    expect(timeout.record).toEqual({ type: "timeout", seat: 0 });
    expect(timeout.state.out[0]).toEqual({ atMove: 5, reason: "timed_out" });
  });

  it("keeps a shown missed pair when the seat to act leaves before its first card", () => {
    const before = game({ seats: 3, turn: 1, lastMiss: { seat: 0, cards: [0, 2] } });
    const state = def.onResign(before, 1, noRandom, "decline").state;
    expect(state).toMatchObject({ turn: 2, lastMiss: { seat: 0, cards: [0, 2] }, turned: null });
  });

  it("turns the first card back face down when the seat to act leaves mid-turn", () => {
    const before = game({ seats: 3, turn: 1, turned: 6 });
    const state = def.onTimeout(before, 1, noRandom).state;
    expect(state).toMatchObject({ turn: 2, turned: null, lastMiss: null, endReason: null });
  });

  it("keeps the turn when another seat leaves", () => {
    const before = game({ seats: 3, turn: 1, turned: 6 });
    const state = resign(before, 2);
    expect(state).toMatchObject({ turn: 1, turned: 6, endReason: null });
  });

  it("ends a 2-player game last-standing at a resignation, keeping the leaver's pairs", () => {
    const before = game({
      matched: [
        [0, 1],
        [1, 1],
        [2, 0],
        [3, 0],
        [4, 1],
        [5, 1],
      ],
      turned: 8,
    });
    const state = resign(before, 1);
    expect(state).toMatchObject({ endReason: "last-standing", turn: null, turned: null });
    expect(def.result(state)).toEqual({
      endReason: "last-standing",
      ranking: [
        { seat: 0, rank: 1, score: 1 },
        { seat: 1, rank: 2, score: 2 },
      ],
    });
    expect(def.summary(state, null).scores).toEqual([1, 2]);
  });

  it("clears a shown missed pair when a leave ends the game", () => {
    const before = game({ lastMiss: { seat: 1, cards: [0, 2] } });
    const state = resign(before, 1);
    expect(state).toMatchObject({ endReason: "last-standing", lastMiss: null, turned: null });
  });

  it("leaves a seat already out, or a finished game, as it is", () => {
    const out = game({ seats: 3, out: [null, { atMove: 1, reason: "resigned" }, null] });
    expect(resign(out, 1)).toEqual(out);
    const over = resign(game(), 1);
    expect(resign(over, 0)).toEqual(over);
  });
});

describe("ranking (pairs §6)", () => {
  /** A finished game with these pairs found and these leavers. */
  function finished(pairs: readonly number[], out: State["out"]): State {
    const matched: [number, Seat][] = [];
    let card = 0;
    pairs.forEach((count, seat) => {
      for (let i = 0; i < count * 2; i += 1) {
        matched.push([card, seat]);
        card += 1;
      }
    });
    return { ...game({ grid: "4x4", matched, out }), turn: null, endReason: "all-found" };
  }

  it("shares a rank between ties, and skips the next", () => {
    expect(def.result(finished([3, 2, 3], [null, null, null]))?.ranking).toEqual([
      { seat: 0, rank: 1, score: 3 },
      { seat: 2, rank: 1, score: 3 },
      { seat: 1, rank: 3, score: 2 },
    ]);
  });

  it("puts leavers below every seat still playing, whatever their pairs, later leavers higher", () => {
    const state = finished(
      [0, 5, 1, 2],
      [null, { atMove: 4, reason: "resigned" }, null, { atMove: 9, reason: "timed_out" }],
    );
    expect(def.result(state)?.ranking).toEqual([
      { seat: 2, rank: 1, score: 1 },
      { seat: 0, rank: 2, score: 0 },
      { seat: 3, rank: 3, score: 2 },
      { seat: 1, rank: 4, score: 5 },
    ]);
  });

  it("ranks several leavers by when they left in a last-standing ending", () => {
    let state = game({
      seats: 4,
      matched: [
        [0, 3],
        [1, 3],
      ],
    });
    state = resign(state, 3);
    state = def.onResign(state, 1, noRandom, "decline").state;
    state = def.onTimeout(state, 0, noRandom).state;
    expect(def.result(state)).toEqual({
      endReason: "last-standing",
      ranking: [
        { seat: 2, rank: 1, score: 0 },
        { seat: 0, rank: 2, score: 0 },
        { seat: 1, rank: 3, score: 0 },
        { seat: 3, rank: 4, score: 1 },
      ],
    });
  });

  it("is null while the game is in progress", () => {
    expect(def.result(game())).toBeNull();
  });
});
