import { describe, expect, it } from "vitest";

import { game, noRandom } from "../test-support.js";
import { at } from "./at.js";
import { pairsV1 as def } from "./definition.js";
import { gridOf, viewSchema, type GridId } from "./schemas.js";
import { seatToAct } from "./state.js";

describe("engine guards: an impossible input is a bug, so it throws (02 §2.1 rule 3)", () => {
  it("reads only indexes in range", () => {
    expect(at([1, 2, 3], 2)).toBe(3);
    expect(() => at([1, 2, 3], 3)).toThrow(RangeError);
    expect(() => at([1, 2, 3], -1)).toThrow(RangeError);
    expect(() => at([1, 2, 3], 0.5)).toThrow(RangeError);
  });

  it("knows only the four grids", () => {
    expect(gridOf("6x6").pairs).toBe(18);
    expect(() => gridOf("8x8" as GridId)).toThrow(RangeError);
  });

  it("has no seat to act once the game is over", () => {
    expect(seatToAct(game({ turn: 1 }))).toBe(1);
    expect(() => seatToAct({ ...game(), turn: null, endReason: "all-found" })).toThrow();
  });

  it("finds no next seat when the seat to act is the only one playing", () => {
    // Unreachable by the rules: the game ends last-standing first.
    const alone = game({ turned: 0, out: [null, { atMove: 1, reason: "resigned" }] });
    expect(() => def.apply(alone, 0, { type: "flip", row: 0, column: 2 }, noRandom)).toThrow();
  });
});

describe("the view schema's shape checks (pairs §8.6)", () => {
  const view = def.view(game(), null);

  it("wants the faces in play ascending and distinct", () => {
    expect(viewSchema.safeParse(view).success).toBe(true);
    const [a = 0, b = 0, ...rest] = view.faces;
    expect(viewSchema.safeParse({ ...view, faces: [b, a, ...rest] }).success).toBe(false);
    expect(viewSchema.safeParse({ ...view, faces: [a, a, ...rest] }).success).toBe(false);
  });

  it("bounds moves, seats and faces", () => {
    expect(viewSchema.safeParse({ ...view, moves: 1303 }).success).toBe(true);
    expect(viewSchema.safeParse({ ...view, moves: 1304 }).success).toBe(false);
    expect(viewSchema.safeParse({ ...view, turn: 6 }).success).toBe(false);
    expect(viewSchema.safeParse({ ...view, moveLimit: 300 }).success).toBe(false);
    expect(viewSchema.safeParse({ ...view, pairs: [0] }).success).toBe(false);
    const down = { state: "down", face: 3, by: 0 };
    expect(
      viewSchema.safeParse({
        ...view,
        cards: [[down, ...(view.cards[0] ?? []).slice(1)], ...view.cards.slice(1)],
      }).success,
    ).toBe(false);
  });
});
