/**
 * `validate` and `preview` (words §3, §10.3, §10.5): the check order, the dictionary coming last,
 * swaps, and errors computed only from the submitter's rack and the public board.
 */
import { OK } from "@your-move/sdk";
import { describe, expect, it } from "vitest";

import { board, dictionary, play, rack, ruleset, state } from "../test-support.js";
import { preview, validate } from "./rules.js";

const CLASSIC = ruleset("classic");
const [SR, SC] = CLASSIC.start;
const WORDS = dictionary("cat cats at ta ox ax ao tx scat");
const CAT = { row: SR, col: SC - 1, word: "cat" };
const withCat = (racks: string[][], fields = {}) =>
  state({ racks, board: board(CLASSIC, [CAT]), ...fields });

describe("validate (words §10.3)", () => {
  it("accepts a play whose every word is in the dictionary", () => {
    const s = withCat([rack("sxyzqjk"), rack("eeeeeee")]);
    expect(validate(s, 0, play([{ row: SR, col: SC + 2, word: "s" }]), WORDS)).toEqual(OK);
  });

  it("refuses words not in the dictionary last, naming each once in the order formed", () => {
    const s = withCat([rack("oxabcde"), rack("eeeeeee")]);
    // OX across, AO and TX down: only "ao" and "tx" are words here.
    const words = dictionary("ao tx");
    expect(validate(s, 0, play([{ row: SR + 1, col: SC, word: "ox" }]), words)).toEqual({
      code: "INVALID_WORDS",
      detail: { words: ["ox"] },
    });
    expect(validate(s, 0, play([{ row: SR + 1, col: SC, word: "ox" }]), dictionary(""))).toEqual({
      code: "INVALID_WORDS",
      detail: { words: ["ox", "ao", "tx"] },
    });
  });

  it("never reaches the dictionary for a play using tiles not in the rack", () => {
    const s = withCat([rack("abcdefg"), rack("oeeeeee")]);
    // "ox" would form non-words, but the rack check comes first.
    expect(validate(s, 0, play([{ row: SR + 1, col: SC, word: "ox" }]), dictionary(""))).toEqual({
      code: "INVALID_PLACEMENT",
      detail: "TILE_NOT_IN_RACK",
    });
  });

  it("accepts nothing without a dictionary", () => {
    const s = withCat([rack("sabcdef"), rack("eeeeeee")]);
    expect(validate(s, 0, play([{ row: SR, col: SC + 2, word: "s" }]), {})).toEqual({
      code: "INVALID_WORDS",
      detail: { words: ["cats"] },
    });
  });

  it("refuses a seat that isn't to act, and every seat once the game is over", () => {
    const s = withCat([rack("sabcdef"), rack("eeeeeee")]);
    expect(validate(s, 1, { type: "pass" }, WORDS)).toEqual({ code: "NOT_TO_ACT" });
    const over = { ...s, finished: { reason: "resign" as const, adjustments: [0, 0], leaver: 1 } };
    expect(validate(over, 0, { type: "pass" }, WORDS)).toEqual({ code: "NOT_TO_ACT" });
  });

  it("always accepts a pass", () => {
    expect(validate(withCat([rack("a"), rack("b")]), 0, { type: "pass" }, {})).toEqual(OK);
  });

  describe("swap (words §3.2)", () => {
    const racks = [rack("aabcdef"), rack("eeeeeee")];

    it("accepts 1 to rackSize tiles held in the rack while the bag holds swapMinBag", () => {
      const s = state({ racks });
      expect(s.bag.length).toBeGreaterThanOrEqual(CLASSIC.swapMinBag);
      expect(validate(s, 0, { type: "swap", tiles: ["a"] }, {})).toEqual(OK);
      expect(validate(s, 0, { type: "swap", tiles: rack("aabcdef") }, {})).toEqual(OK);
      const small = { ...s, bag: s.bag.slice(0, CLASSIC.swapMinBag) };
      expect(validate(small, 0, { type: "swap", tiles: ["a", "a"] }, {})).toEqual(OK);
    });

    it("refuses a swap when the bag holds fewer than swapMinBag tiles", () => {
      const s = state({ racks });
      const small = { ...s, bag: s.bag.slice(0, CLASSIC.swapMinBag - 1) };
      expect(validate(small, 0, { type: "swap", tiles: ["a"] }, {})).toEqual({
        code: "SWAP_NOT_ALLOWED",
        detail: "BAG_TOO_SMALL",
      });
    });

    it("refuses tiles the rack doesn't hold, counting repeats", () => {
      const s = state({ racks });
      for (const tiles of [["z"], ["b", "b"], rack("aabcdefa")]) {
        expect(validate(s, 0, { type: "swap", tiles }, {})).toEqual({
          code: "SWAP_NOT_ALLOWED",
          detail: "TILE_NOT_IN_RACK",
        });
      }
    });
  });
});

describe("preview (words §10.5)", () => {
  it("gives a legal play's words, score and bingo", () => {
    const s = withCat([rack("sabcdef"), rack("eeeeeee")]);
    const result = preview(s, 0, play([{ row: SR, col: SC + 2, word: "s" }]), WORDS);
    expect(result).toEqual({
      score: expect.any(Number) as number,
      words: [{ word: "cats", score: expect.any(Number) as number }],
      bingo: false,
    });
  });

  it("gives the same error as validate, in the same order", () => {
    const s = withCat([rack("abcdefg"), rack("oeeeeee")]);
    const action = play([{ row: SR + 1, col: SC, word: "ox" }]);
    expect(preview(s, 0, action, WORDS)).toEqual(validate(s, 0, action, WORDS));
    expect(preview(s, 1, { type: "pass" }, WORDS)).toEqual({ code: "NOT_TO_ACT" });
  });

  it("previews a swap or a pass as scoring nothing", () => {
    const s = state({ racks: [rack("aabcdef"), rack("eeeeeee")] });
    const nothing = { score: 0, words: [], bingo: false };
    expect(preview(s, 0, { type: "pass" }, {})).toEqual(nothing);
    expect(preview(s, 0, { type: "swap", tiles: ["a"] }, {})).toEqual(nothing);
  });
});

describe("secrecy of validate and preview (words §7, 02 §2.1 rule 4)", () => {
  it("answers the same whatever the other rack and the bag hold", () => {
    const actions = [
      play([{ row: SR, col: SC + 2, word: "s" }]),
      play([{ row: SR + 1, col: SC, word: "ox" }]),
      { type: "swap" as const, tiles: ["s", "q"] },
    ];
    const a = withCat([rack("sabcdeq"), rack("eeeeeee")]);
    const b = withCat([rack("sabcdeq"), rack("oxyzjkw")]);
    const shuffled = { ...b, bag: [...b.bag].reverse() };
    for (const action of actions) {
      expect(validate(shuffled, 0, action, WORDS)).toEqual(validate(a, 0, action, WORDS));
      expect(preview(shuffled, 0, action, WORDS)).toEqual(preview(a, 0, action, WORDS));
    }
  });
});
