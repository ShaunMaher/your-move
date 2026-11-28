import type { Seat } from "@your-move/sdk";
import { seededRandom } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { flipAt, game, noRandom } from "../test-support.js";
import { pairsV1 as def } from "./definition.js";
import { recordSchema, viewSchema, type Card, type PublicRecord } from "./schemas.js";
import type { State } from "./state.js";

/** Every viewer: each seat and the public. */
const viewers = (state: State): (Seat | null)[] => [...state.out.map((_, seat) => seat), null];

/** The cards of the view, flattened into card-index order. */
const cards = (state: State): Card[] => def.view(state, null).cards.flat();

/** The card indexes whose face the view shows. */
const shown = (state: State): number[] =>
  cards(state).flatMap((card, index) => (card.face === null ? [] : [index]));

describe("the view (pairs §4, §8.4)", () => {
  const state = game({
    seats: 3,
    turn: 2,
    turned: 9,
    matched: [
      [0, 1],
      [1, 1],
    ],
    out: [null, { atMove: 4, reason: "timed_out" }, null],
    moves: 12,
  });

  it("is the same JSON for every seat and the public, and matches its schema", () => {
    const json = JSON.stringify(def.view(state, null));
    for (const viewer of viewers(state)) {
      expect(JSON.stringify(def.view(state, viewer))).toBe(json);
    }
    expect(viewSchema.parse(def.view(state, 0))).toEqual(def.view(state, 0));
  });

  it("lays out every field in order, the faces in play ascending and the cards by row", () => {
    const view = def.view(
      game({ grid: "4x4", faces: [7, 3, 3, 7, 1, 1, 0, 0, 2, 2, 4, 4, 5, 5, 6, 6] }),
      0,
    );
    expect(Object.keys(view)).toEqual([
      "grid",
      "columns",
      "rows",
      "faces",
      "cards",
      "turn",
      "pairs",
      "out",
      "moves",
      "moveLimit",
      "endReason",
    ]);
    expect(view).toMatchObject({ grid: "4x4", columns: 4, rows: 4, moveLimit: 256 });
    expect(view.faces).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(view.cards).toHaveLength(4);
    for (const row of view.cards) expect(row).toHaveLength(4);
  });

  it("shows matched and up cards with their seat, and hides every other face", () => {
    const view = def.view(state, null);
    expect(view.cards[0]).toEqual([
      { state: "matched", face: 0, by: 1 },
      { state: "matched", face: 0, by: 1 },
      { state: "down", face: null, by: null },
      { state: "down", face: null, by: null },
    ]);
    // Card 9 is row 2, column 1.
    expect(view.cards[2]?.[1]).toEqual({ state: "up", face: 4, by: 2 });
    expect(shown(state)).toEqual([0, 1, 9]);
    expect(view).toMatchObject({
      turn: 2,
      pairs: [0, 1, 0],
      out: [null, "timed_out", null],
      moves: 12,
      moveLimit: 400,
      endReason: null,
    });
    for (const card of cards(state)) expect(Object.keys(card)).toEqual(["state", "face", "by"]);
  });

  it("shows a missed pair in every view until the next first card, and in none after", () => {
    const missed = def.apply(game({ seats: 3, turned: 4 }), 0, flipAt(7), noRandom).state;
    for (const viewer of viewers(missed)) {
      const seen = def.view(missed, viewer).cards.flat();
      expect(seen[4]).toEqual({ state: "missed", face: 2, by: 0 });
      expect(seen[7]).toEqual({ state: "missed", face: 3, by: 0 });
    }
    // Still shown after the next seat leaves before turning a card, for the seat after it.
    const kept = def.onResign(missed, 1, noRandom, "decline").state;
    expect(shown(kept)).toEqual([4, 7]);
    const next = def.apply(kept, 2, flipAt(12), noRandom).state;
    expect(shown(next)).toEqual([12]);
    for (const viewer of viewers(next)) {
      expect(def.view(next, viewer).cards.flat()[4]).toEqual({
        state: "down",
        face: null,
        by: null,
      });
    }
  });

  it("shows a first card turned back by a resignation in no view after it", () => {
    const up = def.apply(game({ seats: 3 }), 0, flipAt(5), noRandom).state;
    expect(shown(up)).toEqual([5]);
    const left = def.onResign(up, 0, noRandom, "resign").state;
    expect(left.endReason).toBeNull();
    expect(shown(left)).toEqual([]);
  });

  it("shows every face once the game is over, as matched or down cards only", () => {
    // A resignation that ends the game mid-turn, and one while a missed pair is shown.
    for (const before of [
      game({
        turned: 3,
        matched: [
          [0, 0],
          [1, 0],
        ],
      }),
      game({
        turn: 1,
        lastMiss: { seat: 0, cards: [2, 4] },
        matched: [
          [0, 0],
          [1, 0],
        ],
      }),
    ]) {
      const over = def.onResign(before, 1, noRandom, "resign").state;
      expect(over.endReason).toBe("last-standing");
      const seen = cards(over);
      expect(seen.slice(0, 2)).toEqual([
        { state: "matched", face: 0, by: 0 },
        { state: "matched", face: 0, by: 0 },
      ]);
      seen.slice(2).forEach((card, i) => {
        expect(card).toEqual({ state: "down", face: over.faces[i + 2], by: null });
      });
      expect(def.view(over, null).turn).toBeNull();
    }
  });

  it("shows a frozen in-progress state as it stood (a framework-only ending)", () => {
    // `declined` or an operator cancel freezes the state: endReason stays null (02 §4, §5).
    const frozen = game({ seats: 3, turned: 9 });
    expect(shown(frozen)).toEqual([9]);
    expect(def.view(frozen, null).endReason).toBeNull();
  });

  it("follows no part of the layout in its shape", () => {
    const a = game({ seats: 3 });
    const b = { ...a, faces: [...a.faces].reverse() };
    expect(JSON.stringify(def.view(b, 1))).toBe(JSON.stringify(def.view(a, 1)));
  });
});

describe("records and text (pairs §8.5)", () => {
  const before = game({ seats: 3, turn: 0 });
  const first = def.apply(before, 0, flipAt(0), noRandom);
  const second = def.apply(first.state, 0, flipAt(3), noRandom);

  it.each([
    ["a first card", first.record, { type: "flip", seat: 0, step: 1 }, " turned over a card"],
    [
      "a second card",
      second.record,
      { type: "flip", seat: 0, step: 2 },
      " turned over a second card",
    ],
    [
      "a resignation",
      def.onResign(before, 1, noRandom, "resign").record,
      { type: "resign", seat: 1 },
      " resigned",
    ],
    [
      "a timeout",
      def.onTimeout(before, 1, noRandom).record,
      { type: "timeout", seat: 1 },
      " ran out of time",
    ],
    [
      "a decline",
      def.onResign(before, 1, noRandom, "decline").record,
      { type: "decline", seat: 1 },
      " declined the game",
    ],
  ] as const)("records %s and describes it", (_name, record, expected, text) => {
    expect(record).toEqual(expected);
    expect(Object.keys(record)).toEqual(Object.keys(expected));
    expect(recordSchema.parse(record)).toEqual(record);
    expect(def.describe(record)).toEqual([{ seat: expected.seat }, text]);
  });

  it("gives the same record for a match and a miss, and for any card", () => {
    const match = def.apply(first.state, 0, flipAt(1), noRandom).record;
    expect(match).toEqual(second.record);
    expect(def.apply(before, 0, flipAt(17), noRandom).record).toEqual(first.record);
  });

  it("names no row, column or face in any record or its text, over whole games", () => {
    const records: PublicRecord[] = [];
    for (const seed of [1, 2, 3]) {
      const rng = seededRandom(seed);
      let state = def.setup({ options: { grid: "6x6" }, seats: 3, rng });
      while (state.turn !== null) {
        const seat: Seat = state.turn;
        const action = def.test.randomAction(state, seat, rng, {});
        const next =
          rng.nextInt(50) === 0
            ? def.onResign(state, seat, rng, "resign")
            : def.apply(state, seat, action, rng);
        records.push(next.record);
        state = next.state;
      }
    }
    expect(records.length).toBeGreaterThan(100);
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(
        record.type === "flip" ? ["seat", "step", "type"] : ["seat", "type"],
      );
      const text = def.describe(record);
      expect(text.filter((part) => typeof part === "string").join("")).not.toMatch(/\d/u);
    }
  });
});

describe("summary (pairs §8.5)", () => {
  it("counts the pairs left and says whose turn it is", () => {
    const state = game({
      seats: 3,
      turn: 1,
      matched: [
        [0, 2],
        [1, 2],
      ],
    });
    expect(def.summary(state, 1)).toEqual({
      headline: ["9 pairs left · your turn"],
      scores: [0, 0, 1],
    });
    expect(def.summary(state, 0)).toEqual({
      headline: ["9 pairs left · ", { seat: 1 }, " to play"],
      scores: [0, 0, 1],
    });
    expect(def.summary(state, null)).toEqual(def.summary(state, 2));
  });

  it("says one pair left in the singular", () => {
    const base = game();
    const matched = base.faces.flatMap((_, card) => (card < 18 ? [[card, 0] as const] : []));
    expect(def.summary(game({ matched }), 0).headline).toEqual(["1 pair left · your turn"]);
  });

  it("names the winner, or a shared win, once over", () => {
    const won = def.onResign(
      game({
        matched: [
          [0, 0],
          [1, 0],
        ],
      }),
      1,
      noRandom,
      "resign",
    ).state;
    expect(def.summary(won, 1)).toEqual({ headline: [{ seat: 0 }, " won"], scores: [1, 0] });
    const tied = {
      ...game({
        grid: "4x4",
        matched: [
          [0, 0],
          [1, 0],
          [2, 1],
          [3, 1],
        ],
      }),
      turn: null,
      endReason: "move-limit" as const,
    };
    expect(def.summary(tied, null)).toEqual({ headline: ["Shared win"], scores: [1, 1] });
  });
});
