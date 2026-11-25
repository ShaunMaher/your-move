import { describe, expect, it } from "vitest";

import {
  cancelBlank,
  initial,
  move,
  onRack,
  orderFrom,
  placedCount,
  recall,
  reorder,
  savedOrder,
  setBlankLetter,
  squareKey,
  squareOf,
  toPlacements,
} from "./tentative.js";

// The rack as the view shows it: letters a–z, then blanks.
const RACK = ["a", "b", "s", "t", "?"];

describe("the rack's shown order", () => {
  it("starts as the view's order, or the saved one where it still fits", () => {
    expect(orderFrom(RACK, null)).toEqual([0, 1, 2, 3, 4]);
    expect(orderFrom(RACK, "ts?ab")).toEqual([3, 2, 4, 0, 1]);
    // Letters the rack no longer holds are skipped, new tiles go last.
    expect(orderFrom(RACK, "zsa")).toEqual([2, 0, 1, 3, 4]);
    expect(orderFrom(["e", "e", "x"], "ee")).toEqual([0, 1, 2]);
    expect(orderFrom(["e", "x"], "eee")).toEqual([0, 1]);
  });

  it("saves as letters and reorders", () => {
    const t = reorder(initial(RACK), [4, 3, 2, 1, 0]);
    expect(savedOrder(t, RACK)).toBe("?tsba");
    expect(onRack(t)).toEqual([4, 3, 2, 1, 0]);
  });
});

describe("moving tiles", () => {
  it("puts a rack tile on a square, and takes it back to the front of another tile", () => {
    const placed = move(
      initial(RACK),
      RACK,
      { kind: "rack", id: 2 },
      { kind: "square", key: "7,7" },
    );
    expect(placed.placed).toEqual({ "7,7": { id: 2 } });
    expect(onRack(placed)).toEqual([0, 1, 3, 4]);
    expect(squareOf(placed, 2)).toBe("7,7");
    expect(squareOf(placed, 0)).toBeNull();
    expect(placedCount(placed)).toBe(1);
    const back = move(placed, RACK, { kind: "square", key: "7,7" }, { kind: "rack", before: 1 });
    expect(back.placed).toEqual({});
    expect(back.order).toEqual([0, 2, 1, 3, 4]);
  });

  it("returns a tile to the end of the rack when dropped past the last tile", () => {
    const placed = move(
      initial(RACK),
      RACK,
      { kind: "rack", id: 0 },
      { kind: "square", key: "1,1" },
    );
    expect(
      move(placed, RACK, { kind: "square", key: "1,1" }, { kind: "rack", before: null }).order,
    ).toEqual([1, 2, 3, 4, 0]);
  });

  it("moves a placed tile to another square, never onto a taken one", () => {
    let t = move(initial(RACK), RACK, { kind: "rack", id: 0 }, { kind: "square", key: "1,1" });
    t = move(t, RACK, { kind: "rack", id: 1 }, { kind: "square", key: "1,2" });
    expect(move(t, RACK, { kind: "square", key: "1,1" }, { kind: "square", key: "1,2" })).toBe(t);
    expect(move(t, RACK, { kind: "rack", id: 2 }, { kind: "square", key: "1,2" })).toBe(t);
    expect(move(t, RACK, { kind: "square", key: "1,1" }, { kind: "square", key: "1,1" })).toBe(t);
    const moved = move(t, RACK, { kind: "square", key: "1,1" }, { kind: "square", key: "2,1" });
    expect(Object.keys(moved.placed).sort()).toEqual(["1,2", "2,1"]);
  });

  it("reorders the rack by dropping a rack tile in front of another, or on itself", () => {
    const t = initial(RACK);
    expect(move(t, RACK, { kind: "rack", id: 3 }, { kind: "rack", before: 0 }).order).toEqual([
      3, 0, 1, 2, 4,
    ]);
    expect(move(t, RACK, { kind: "rack", id: 0 }, { kind: "rack", before: null }).order).toEqual([
      1, 2, 3, 4, 0,
    ]);
    expect(move(t, RACK, { kind: "rack", id: 2 }, { kind: "rack", before: 2 })).toBe(t);
  });

  it("ignores picking up a square with no tile", () => {
    const t = initial(RACK);
    expect(move(t, RACK, { kind: "square", key: "3,3" }, { kind: "rack", before: null })).toBe(t);
  });
});

describe("blanks", () => {
  it("asks for a letter when a blank is placed, and keeps it when the blank moves", () => {
    let t = move(initial(RACK), RACK, { kind: "rack", id: 4 }, { kind: "square", key: "7,7" });
    expect(t.blankFor).toBe("7,7");
    expect(toPlacements(t, RACK)).toEqual([]);
    t = setBlankLetter(t, "q");
    expect(t.blankFor).toBeNull();
    expect(toPlacements(t, RACK)).toEqual([{ row: 7, col: 7, tile: "?", letter: "q" }]);
    t = move(t, RACK, { kind: "square", key: "7,7" }, { kind: "square", key: "7,8" });
    expect(t.blankFor).toBeNull();
    expect(toPlacements(t, RACK)).toEqual([{ row: 7, col: 8, tile: "?", letter: "q" }]);
  });

  it("takes a blank back to the rack when the picker is dismissed or the blank is returned", () => {
    const asked = move(
      initial(RACK),
      RACK,
      { kind: "rack", id: 4 },
      { kind: "square", key: "7,7" },
    );
    expect(cancelBlank(asked).placed).toEqual({});
    expect(cancelBlank(asked).blankFor).toBeNull();
    const returned = move(
      asked,
      RACK,
      { kind: "square", key: "7,7" },
      { kind: "rack", before: null },
    );
    expect(returned.blankFor).toBeNull();
    expect(cancelBlank(initial(RACK))).toEqual(initial(RACK));
    expect(setBlankLetter(initial(RACK), "a")).toEqual(initial(RACK));
  });

  it("forgets the letter when a blank goes back to the rack", () => {
    let t = move(initial(RACK), RACK, { kind: "rack", id: 4 }, { kind: "square", key: "7,7" });
    t = setBlankLetter(t, "e");
    t = move(t, RACK, { kind: "square", key: "7,7" }, { kind: "rack", before: null });
    t = move(t, RACK, { kind: "rack", id: 4 }, { kind: "square", key: "8,8" });
    expect(t.blankFor).toBe("8,8");
  });
});

describe("recall and placements", () => {
  it("recalls every tile and lists the placed ones in board order", () => {
    let t = move(initial(RACK), RACK, { kind: "rack", id: 3 }, { kind: "square", key: "7,9" });
    t = move(t, RACK, { kind: "rack", id: 2 }, { kind: "square", key: "7,8" });
    t = move(t, RACK, { kind: "rack", id: 0 }, { kind: "square", key: "6,12" });
    expect(toPlacements(t, RACK)).toEqual([
      { row: 6, col: 12, tile: "a" },
      { row: 7, col: 8, tile: "s" },
      { row: 7, col: 9, tile: "t" },
    ]);
    expect(recall(t).placed).toEqual({});
    expect(onRack(recall(t))).toEqual([0, 1, 2, 3, 4]);
    expect(squareKey(6, 12)).toBe("6,12");
  });

  it("drops a placed tile whose rack tile is gone", () => {
    const t = { ...initial(RACK), placed: { "1,1": { id: 99 } } };
    expect(toPlacements(t, RACK)).toEqual([]);
  });
});
