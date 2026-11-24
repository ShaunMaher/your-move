/**
 * Views, summaries and history text (words §7, §10.4, §10.6): hidden racks and bag, the reveal
 * at the end, sorted racks, and records that never name swapped tiles.
 */
import { describe, expect, it } from "vitest";

import { board, rack, ruleset, state } from "../test-support.js";
import { wordsV1 as words } from "./definition.js";
import { describe as describeRecord, sortedRack, summary, view } from "./present.js";
import type { PublicRecord } from "./schemas.js";

const CLASSIC = ruleset("classic");
const [SR, SC] = CLASSIC.start;

const s = state({
  racks: [rack("zq?abce"), rack("sdeeeee")],
  board: board(CLASSIC, [{ row: SR, col: SC - 1, word: "cAt" }]),
  scores: [12, 7],
});

describe("view (words §7, §10.4)", () => {
  it("shows a seat the board, every score and count, and only its own rack, sorted", () => {
    const v = view(s, 0);
    expect(v.ruleset).toEqual({ id: "classic", version: 1 });
    expect(v.dictionary).toEqual({ id: s.options.dictionaryId, version: 1 });
    expect(v.board[SR]?.slice(SC - 1, SC + 2)).toEqual([
      { tile: "c", letter: "c", blank: false },
      { tile: "?", letter: "a", blank: true },
      { tile: "t", letter: "t", blank: false },
    ]);
    expect(v.board[0]?.[0]).toBeNull();
    expect(v.scores).toEqual([12, 7]);
    expect(v.rackCounts).toEqual([7, 7]);
    expect(v.bagCount).toBe(s.bag.length);
    expect(v.yourRack).toEqual(rack("abceqz?"));
    expect(v.lastMove).toBeNull();
    expect(v.final).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain('"sdeeeee"');
    expect(view(s, 1).yourRack).toEqual(rack("deeeees"));
  });

  it("shows the public no rack at all", () => {
    expect(view(s, null).yourRack).toBeNull();
  });

  it("never depends on the other rack or the bag order while the game is in progress", () => {
    const other = { ...s, racks: [s.racks[0] ?? [], rack("xyzzzzz")], bag: [...s.bag].reverse() };
    expect(JSON.stringify(view(other, 0))).toBe(JSON.stringify(view(s, 0)));
    expect(JSON.stringify(summary(other))).toBe(JSON.stringify(summary(s)));
  });

  it("reveals every final rack, sorted, once the game is over, but never the bag", () => {
    const over = words.onResign(s, 1, { nextInt: () => 0 }, "resign").state;
    const v = view(over, null);
    expect(v.final).toEqual({
      reason: "resign",
      adjustments: [0, 0],
      racks: [rack("abceqz?"), rack("deeeees")],
    });
    expect(v.lastMove).toEqual({ seat: 1, type: "resign", score: 0, bingo: false });
    expect(v.bagCount).toBe(s.bag.length);
    expect(JSON.stringify(v)).not.toContain(JSON.stringify(s.bag));
  });

  it("sorts blanks after the letters", () => {
    expect(sortedRack(rack("?b?aab"))).toEqual(rack("aabb??"));
  });
});

describe("summary (words §10.6)", () => {
  it("puts both scores between the two seats", () => {
    expect(summary(s)).toEqual({
      headline: [{ seat: 0 }, " 12 – 7 ", { seat: 1 }],
      scores: [12, 7],
    });
  });

  it("lists every seat's score with more seats", () => {
    const three = { ...s, scores: [1, 2, 3] };
    expect(summary(three).headline).toEqual([
      { seat: 0 },
      " 1",
      ", ",
      { seat: 1 },
      " 2",
      ", ",
      { seat: 2 },
      " 3",
    ]);
  });
});

describe("describe (words §10.6, 02 §2.1 rule 9)", () => {
  const base = { seat: 1, score: 0, bingo: false };
  it.each<[PublicRecord, (string | { seat: number })[]]>([
    [
      {
        ...base,
        type: "play",
        placements: [{ row: 0, col: 0, tile: "q", letter: "q" }],
        words: [
          { word: "quiz", score: 60 },
          { word: "qi", score: 4 },
        ],
        score: 64,
      },
      [{ seat: 1 }, " played QUIZ for 64"],
    ],
    [
      { ...base, type: "play", words: [{ word: "aerosol", score: 9 }], score: 59, bingo: true },
      [{ seat: 1 }, " played AEROSOL for 59, using every tile"],
    ],
    [{ ...base, type: "play", score: 0 }, [{ seat: 1 }, " played  for 0"]],
    [{ ...base, type: "swap", swapCount: 3 }, [{ seat: 1 }, " swapped 3 tiles"]],
    [{ ...base, type: "swap", swapCount: 1 }, [{ seat: 1 }, " swapped 1 tile"]],
    [{ ...base, type: "swap" }, [{ seat: 1 }, " swapped 0 tiles"]],
    [{ ...base, type: "pass" }, [{ seat: 1 }, " passed"]],
    [{ ...base, type: "resign" }, [{ seat: 1 }, " resigned"]],
    [{ ...base, type: "timeout" }, [{ seat: 1 }, " ran out of time"]],
    [{ ...base, type: "decline" }, [{ seat: 1 }, " declined the game"]],
  ])("describes %j", (record, text) => {
    expect(describeRecord(record)).toEqual(text);
  });

  it("never names the tiles of a swap: two swaps of as many tiles give the same record", () => {
    const a = words.apply(s, 0, { type: "swap", tiles: ["z", "q"] }, { nextInt: () => 0 });
    const b = words.apply(s, 0, { type: "swap", tiles: ["a", "b"] }, { nextInt: () => 0 });
    expect(a.record).toEqual(b.record);
    expect(view(a.state, 1)).toEqual(view(b.state, 1));
    expect(JSON.stringify(a.record)).not.toMatch(/"[zq]"/u);
  });
});
