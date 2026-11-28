import { describe, expect, it } from "vitest";

import { flipAt, game } from "../test-support.js";
import { validate } from "./rules.js";
import type { Action } from "./schemas.js";

const flip = (row: number, column: number): Action => ({ type: "flip", row, column });

describe("validate (pairs §8.3)", () => {
  // 4 × 5: rows 0–4, columns 0–3. Mid-turn, cards 2 and 3 are matched and card 6 is up; between
  // turns, cards 8 and 10 are the missed pair.
  const midTurn = game({
    seats: 3,
    turn: 1,
    turned: 6,
    matched: [
      [2, 0],
      [3, 0],
    ],
  });
  const betweenTurns = game({ seats: 3, turn: 1, lastMiss: { seat: 0, cards: [8, 10] } });

  it.each([
    ["a down card", midTurn, 1, flipAt(0)],
    ["the last card of the grid", midTurn, 1, flip(4, 3)],
    ["a missed card as the first card", betweenTurns, 1, flipAt(8)],
    ["the other missed card", betweenTurns, 1, flipAt(10)],
  ] as const)("accepts %s", (_name, state, seat, action) => {
    expect(validate(state, seat, action)).toEqual({ ok: true });
  });

  it.each([
    ["a seat not to act", midTurn, 0, flipAt(0), "NOT_TO_ACT"],
    // NOT_TO_ACT comes first: an off-turn flip off the grid of a matched card is still not to act.
    ["a seat not to act, off the grid", midTurn, 2, flip(9, 9), "NOT_TO_ACT"],
    ["a row below 0", midTurn, 1, flip(-1, 0), "OUT_OF_RANGE"],
    ["a row past the last", midTurn, 1, flip(5, 0), "OUT_OF_RANGE"],
    ["a column below 0", midTurn, 1, flip(0, -1), "OUT_OF_RANGE"],
    ["a column past the last", midTurn, 1, flip(0, 4), "OUT_OF_RANGE"],
    ["a huge row", midTurn, 1, flip(2 ** 40, 0), "OUT_OF_RANGE"],
    // A column past the last would otherwise land on the next row's first card.
    [
      "a column that would wrap to a matched card",
      game({ matched: [[4, 1]] }),
      0,
      flip(0, 4),
      "OUT_OF_RANGE",
    ],
    ["a matched card", midTurn, 1, flipAt(2), "CARD_FACE_UP"],
    ["the turn's up card", midTurn, 1, flipAt(6), "CARD_FACE_UP"],
  ] as const)("refuses %s", (_name, state, seat, action, code) => {
    // No code carries a detail (pairs §8.3).
    expect(validate(state, seat, action)).toEqual({ code });
  });

  it("refuses every flip once the game is over", () => {
    const over = { ...game(), turn: null, endReason: "last-standing" as const };
    expect(validate(over, 0, flipAt(0))).toEqual({ code: "NOT_TO_ACT" });
    // Even for the seat that last had the turn, with the turn left set.
    expect(validate({ ...over, turn: 0 }, 0, flipAt(0))).toEqual({ code: "NOT_TO_ACT" });
  });

  it("reads no face: the same answers on any layout", () => {
    const shuffled = { ...midTurn, faces: [...midTurn.faces].reverse() };
    for (let card = 0; card < 20; card += 1) {
      for (const seat of [0, 1]) {
        expect(validate(shuffled, seat, flipAt(card))).toEqual(
          validate(midTurn, seat, flipAt(card)),
        );
      }
    }
  });
});
