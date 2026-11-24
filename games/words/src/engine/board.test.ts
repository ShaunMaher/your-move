/**
 * Placement, word finding and scoring (words §3.1, §4) as rules tables. Scoring tables use
 * rulesets whose only premiums are the squares each case names (`withPremiums`), so they don't
 * depend on where the real layouts put their premiums.
 */
import { isGameError } from "@your-move/sdk";
import { describe, expect, it } from "vitest";

import { board, plain, play, rack, ruleset, withPremiums, type Laid } from "../test-support.js";
import {
  analysePlay,
  emptyBoard,
  isBoardEmpty,
  premiumAt,
  squareAt,
  tilePoints,
  type PlayAnalysis,
} from "./board.js";
import type { Ruleset } from "./rulesets/schema.js";
import type { Placement } from "./schemas.js";

const CLASSIC = plain(ruleset("classic"));
const placed = (words: readonly Laid[]): Placement[] => play(words).placements;
const [SR, SC] = CLASSIC.start;

function analyse(
  rules: Ruleset,
  existing: readonly Laid[],
  tiles: string,
  placements: readonly Placement[],
): PlayAnalysis {
  const result = analysePlay(rules, board(rules, existing), rack(tiles), placements);
  if (isGameError(result)) throw new Error(`refused: ${JSON.stringify(result)}`);
  return result;
}

function refusal(
  existing: readonly Laid[],
  tiles: string,
  placements: readonly Placement[],
  rules: Ruleset = CLASSIC,
): unknown {
  const result = analysePlay(rules, board(rules, existing), rack(tiles), placements);
  return isGameError(result) ? result : null;
}

const CAT: Laid = { row: SR, col: SC - 1, word: "cat" };

describe("placement rules and their check order (words §3.1, §10.3)", () => {
  const cases: {
    name: string;
    existing: Laid[];
    tiles: string;
    placements: Placement[];
    detail: string;
    rules?: Ruleset;
  }[] = [
    {
      name: "more tiles than a rack holds",
      existing: [CAT],
      tiles: "abcdefg",
      placements: Array.from({ length: 8 }, (_, i) => ({ row: SR + 1, col: i, tile: "a" })),
      detail: "TOO_MANY_TILES",
    },
    {
      name: "a square off a smaller board",
      existing: [],
      tiles: "ab",
      placements: [
        { row: 0, col: 1, tile: "a" },
        { row: 0, col: 5, tile: "b" },
      ],
      detail: "OUT_OF_BOUNDS",
      rules: { ...CLASSIC, boardSize: 5, start: [0, 1], premiums: CLASSIC.premiums.slice(0, 5) },
    },
    {
      name: "the same square twice",
      existing: [],
      tiles: "ab",
      placements: [
        { row: SR, col: SC, tile: "a" },
        { row: SR, col: SC, tile: "b" },
      ],
      detail: "DUPLICATE_SQUARE",
    },
    {
      name: "a square already taken",
      existing: [CAT],
      tiles: "s",
      placements: [{ row: SR, col: SC, tile: "s" }],
      detail: "SQUARE_OCCUPIED",
    },
    {
      name: "a blank without a letter",
      existing: [],
      tiles: "a?",
      placements: [
        { row: SR, col: SC, tile: "a" },
        { row: SR, col: SC + 1, tile: "?" },
      ],
      detail: "BLANK_NEEDS_LETTER",
    },
    {
      name: "a letter on a tile that isn't a blank",
      existing: [],
      tiles: "ab",
      placements: [
        { row: SR, col: SC, tile: "a" },
        { row: SR, col: SC + 1, tile: "b", letter: "x" },
      ],
      detail: "LETTER_ON_NON_BLANK",
    },
    {
      name: "a tile the rack doesn't hold",
      existing: [],
      tiles: "ab",
      placements: [
        { row: SR, col: SC, tile: "a" },
        { row: SR, col: SC + 1, tile: "z" },
      ],
      detail: "TILE_NOT_IN_RACK",
    },
    {
      name: "a tile used twice from a rack holding one",
      existing: [],
      tiles: "ab",
      placements: [
        { row: SR, col: SC, tile: "a" },
        { row: SR, col: SC + 1, tile: "a" },
      ],
      detail: "TILE_NOT_IN_RACK",
    },
    {
      name: "tiles in neither one row nor one column",
      existing: [],
      tiles: "ab",
      placements: [
        { row: SR, col: SC, tile: "a" },
        { row: SR + 1, col: SC + 1, tile: "b" },
      ],
      detail: "NOT_IN_LINE",
    },
    {
      name: "a gap in the line",
      existing: [],
      tiles: "ab",
      placements: [
        { row: SR, col: SC, tile: "a" },
        { row: SR, col: SC + 2, tile: "b" },
      ],
      detail: "GAP",
    },
    {
      name: "a gap in a column",
      existing: [CAT],
      tiles: "ab",
      placements: [
        { row: SR + 1, col: SC, tile: "a" },
        { row: SR + 3, col: SC, tile: "b" },
      ],
      detail: "GAP",
    },
    {
      name: "a single tile as the opening play",
      existing: [],
      tiles: "a",
      placements: [{ row: SR, col: SC, tile: "a" }],
      detail: "TOO_FEW_TILES",
    },
    {
      name: "an opening play off the start square",
      existing: [],
      tiles: "ab",
      placements: [
        { row: 0, col: 0, tile: "a" },
        { row: 0, col: 1, tile: "b" },
      ],
      detail: "START_NOT_COVERED",
    },
    {
      name: "a later play touching no tile",
      existing: [CAT],
      tiles: "ab",
      placements: [
        { row: 0, col: 0, tile: "a" },
        { row: 0, col: 1, tile: "b" },
      ],
      detail: "NOT_CONNECTED",
    },
    {
      name: "a later single tile touching only a corner",
      existing: [CAT],
      tiles: "a",
      placements: [{ row: SR + 1, col: SC + 2, tile: "a" }],
      detail: "NOT_CONNECTED",
    },
    {
      // Several rules broken at once: the first in check order wins.
      name: "too many tiles before anything else",
      existing: [CAT],
      tiles: "a",
      placements: Array.from({ length: 8 }, () => ({ row: SR, col: SC, tile: "q" })),
      detail: "TOO_MANY_TILES",
    },
    {
      name: "an occupied square before an off-rack tile",
      existing: [CAT],
      tiles: "a",
      placements: [{ row: SR, col: SC, tile: "q" }],
      detail: "SQUARE_OCCUPIED",
    },
    {
      name: "an off-rack tile before the line",
      existing: [],
      tiles: "a",
      placements: [
        { row: 0, col: 0, tile: "a" },
        { row: 5, col: 5, tile: "q" },
      ],
      detail: "TILE_NOT_IN_RACK",
    },
  ];
  it.each(cases)("refuses $name: $detail", ({ existing, tiles, placements, detail, rules }) => {
    expect(refusal(existing, tiles, placements, rules)).toEqual({
      code: "INVALID_PLACEMENT",
      detail,
    });
  });

  it("accepts a line completed by tiles already on the board", () => {
    // _ C A T _ with tiles on both ends: the main word runs through the existing tiles.
    const result = analyse(CLASSIC, [CAT], "sb", [
      { row: SR, col: SC - 2, tile: "s" },
      { row: SR, col: SC + 2, tile: "b" },
    ]);
    expect(result.words.map((w) => w.word)).toEqual(["scatb"]);
  });

  it("allows the opening play after passes and swaps: only the empty board matters", () => {
    expect(isBoardEmpty(board(CLASSIC))).toBe(true);
    expect(analyse(CLASSIC, [], "at", placed([{ row: SR, col: SC, word: "at" }])).words).toEqual([
      { word: "at", score: 2 },
    ]);
  });

  it("opens down a column as well as along a row", () => {
    const result = analyse(
      CLASSIC,
      [],
      "ta",
      placed([{ row: SR - 1, col: SC, word: "ta", down: true }]),
    );
    expect(result.words.map((w) => w.word)).toEqual(["ta"]);
  });
});

describe("word finding (words §3.1 rule 6)", () => {
  it("finds a single tile's words in both directions", () => {
    // C A T across, and a tile under A forming A? down: two words.
    const existing: Laid[] = [CAT, { row: SR + 1, col: SC - 1, word: "o" }];
    const result = analyse(CLASSIC, existing, "x", [{ row: SR + 1, col: SC, tile: "x" }]);
    expect(result.words.map((w) => w.word)).toEqual(["ox", "ax"]);
  });

  it("finds only the cross-word when a single tile extends nothing along its row", () => {
    const result = analyse(CLASSIC, [CAT], "s", [{ row: SR + 1, col: SC + 1, tile: "s" }]);
    expect(result.words.map((w) => w.word)).toEqual(["ts"]);
  });

  it("finds the main word and every cross-word of a play parallel to a word", () => {
    // C A T at the start row; "ox" played under its A and T forms OX across, AO and TX down.
    const result = analyse(CLASSIC, [CAT], "ox", placed([{ row: SR + 1, col: SC, word: "ox" }]));
    expect(result.words.map((w) => w.word)).toEqual(["ox", "ao", "tx"]);
  });

  it("extends an existing word at either end and through the middle", () => {
    expect(
      analyse(CLASSIC, [CAT], "s", [{ row: SR, col: SC + 2, tile: "s" }]).words.map((w) => w.word),
    ).toEqual(["cats"]);
    expect(
      analyse(CLASSIC, [CAT], "s", [{ row: SR, col: SC - 2, tile: "s" }]).words.map((w) => w.word),
    ).toEqual(["scat"]);
    const through = analyse(CLASSIC, [CAT], "rer", [
      { row: SR - 1, col: SC, tile: "r" },
      { row: SR + 1, col: SC, tile: "e" },
      { row: SR + 2, col: SC, tile: "r" },
    ]);
    expect(through.words.map((w) => w.word)).toEqual(["raer"]);
  });

  it("reads a blank as the letter it stands for", () => {
    const result = analyse(CLASSIC, [], "a?", placed([{ row: SR, col: SC, word: "aT" }]));
    expect(result.words).toEqual([{ word: "at", score: 1 }]);
  });
});

describe("scoring (words §4)", () => {
  // Points in the classic table: c 3, a 1, t 1, s 1, o 1, x 8, q 10, z 10, blank 0.
  const at = (row: number, col: number): string => `${String(row)},${String(col)}`;

  it.each([
    { name: "no premium", premiums: {}, score: 5 },
    { name: "a double letter on a new tile", premiums: { [at(SR, SC)]: "d" as const }, score: 8 },
    { name: "a triple letter on a new tile", premiums: { [at(SR, SC)]: "t" as const }, score: 11 },
    { name: "a double word", premiums: { [at(SR, SC + 1)]: "D" as const }, score: 10 },
    { name: "a triple word", premiums: { [at(SR, SC + 1)]: "T" as const }, score: 15 },
    {
      name: "two double words stacking to four times",
      premiums: { [at(SR, SC)]: "D" as const, [at(SR, SC + 2)]: "D" as const },
      score: 20,
    },
    {
      name: "a double and a triple word stacking to six times",
      premiums: { [at(SR, SC)]: "D" as const, [at(SR, SC + 2)]: "T" as const },
      score: 30,
    },
    {
      name: "a letter and a word premium together",
      premiums: { [at(SR, SC)]: "t" as const, [at(SR, SC + 2)]: "D" as const },
      score: 22,
    },
  ])("scores CAT with $name", ({ premiums, score }) => {
    const rules = withPremiums(CLASSIC, premiums);
    expect(analyse(rules, [], "cat", placed([{ row: SR, col: SC, word: "cat" }])).score).toBe(
      score,
    );
  });

  it("scores a blank as 0 even on a letter premium, but applies its word premium", () => {
    // Q (10) and a blank standing for I: the blank sits on a triple letter, then a triple word.
    const tl = withPremiums(CLASSIC, { [at(SR, SC + 1)]: "t" });
    expect(analyse(tl, [], "q?", placed([{ row: SR, col: SC, word: "qI" }])).score).toBe(10);
    const tw = withPremiums(CLASSIC, { [at(SR, SC + 1)]: "T" });
    expect(analyse(tw, [], "q?", placed([{ row: SR, col: SC, word: "qI" }])).score).toBe(30);
  });

  it("scores a play of only blanks as 0", () => {
    const rules = withPremiums(CLASSIC, { [at(SR, SC)]: "D" });
    expect(analyse(rules, [], "??", placed([{ row: SR, col: SC, word: "AT" }]))).toEqual({
      words: [{ word: "at", score: 0 }],
      score: 0,
      bingo: false,
    });
  });

  it("ignores premiums under tiles already on the board", () => {
    // CAT sits on a triple word and a triple letter; adding S scores only face value (6).
    const rules = withPremiums(CLASSIC, { [at(SR, SC - 1)]: "T", [at(SR, SC)]: "t" });
    expect(analyse(rules, [CAT], "s", [{ row: SR, col: SC + 2, tile: "s" }]).score).toBe(6);
  });

  it("counts a premium under a new tile in every word through it", () => {
    // X on a double word forms AX down and OX across: both doubled.
    const rules = withPremiums(CLASSIC, { [at(SR + 1, SC)]: "D" });
    const result = analyse(rules, [CAT, { row: SR + 1, col: SC - 1, word: "o" }], "x", [
      { row: SR + 1, col: SC, tile: "x" },
    ]);
    expect(result.words).toEqual([
      { word: "ox", score: 18 },
      { word: "ax", score: 18 },
    ]);
    expect(result.score).toBe(36);
  });

  it("adds the bingo bonus for using every rack tile, and only then", () => {
    const word = "aerosol";
    const rules = CLASSIC;
    const seven = analyse(rules, [], word, placed([{ row: SR, col: SC - 3, word }]));
    expect(seven.bingo).toBe(true);
    expect(seven.score).toBe(7 + rules.bingoBonus);
    const six = analyse(rules, [], "aeroso", placed([{ row: SR, col: SC - 3, word: "aeroso" }]));
    expect(six.bingo).toBe(false);
    expect(six.score).toBe(6);
  });

  it("takes the bonus and the rack size from the ruleset", () => {
    const casual = plain(ruleset("casual"));
    const result = analyse(
      casual,
      [],
      "aerosol",
      placed([{ row: SR, col: SC - 3, word: "aerosol" }]),
    );
    // casual: a, e, r, o and s are worth 1, l 2.
    expect(result.score).toBe(8 + casual.bingoBonus);
  });
});

describe("board helpers", () => {
  it("reads squares, premiums and points defensively", () => {
    const grid = emptyBoard(CLASSIC);
    expect(grid).toHaveLength(CLASSIC.boardSize);
    expect(squareAt(grid, -1, 0)).toBeNull();
    expect(squareAt(grid, 0, CLASSIC.boardSize)).toBeNull();
    expect(premiumAt(CLASSIC, 0, 0)).toBeNull();
    expect(premiumAt(withPremiums(CLASSIC, { "0,0": "T" }), 0, 0)).toBe("TW");
    expect(premiumAt(CLASSIC, 99, 99)).toBeNull();
    expect(tilePoints(CLASSIC, "q")).toBe(10);
    expect(tilePoints(CLASSIC, "?")).toBe(0);
    expect(tilePoints(CLASSIC, "constructor")).toBe(0);
  });
});
