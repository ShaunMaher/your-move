import { MAX_WORD_LENGTH } from "@your-move/dictionary";
import { describe, expect, it } from "vitest";

import * as casualModule from "./casual/v1.js";
import * as classicModule from "./classic/v1.js";
import { createRegistry, findRuleset, latestRuleset, RULESETS } from "./index.js";
import {
  adjacentPremiums,
  closestWordPremiums,
  isQuarterTurnSymmetric,
  MAX_BOARD_SIZE,
  MAX_OPENING_MULTIPLIER,
  maxWordMultiplier,
  MIN_WORD_PREMIUM_DISTANCE,
  openingMultiplierLimit,
  openingWordMultiplier,
  WORD_MULTIPLIER_CAP,
  premiumCounts,
  rotatePremiums,
  rulesetSchema,
  totalTiles,
  type Ruleset,
  type RulesetData,
} from "./schema.js";

/** words §8.3 tables A and B, as letter count points triples. */
const TABLE_A = `
  a 9 1   b 2 3   c 2 3   d 4 2   e 12 1  f 2 4   g 3 2   h 2 4   i 9 1
  j 1 8   k 1 5   l 4 1   m 2 3   n 6 1   o 8 1   p 2 3   q 1 10  r 6 1
  s 4 1   t 6 1   u 4 1   v 2 4   w 2 4   x 1 8   y 2 4   z 1 10  ? 2 0`;
const TABLE_B = `
  a 9 1   b 2 4   c 2 4   d 5 2   e 13 1  f 2 4   g 3 3   h 4 3   i 8 1
  j 1 10  k 1 5   l 4 2   m 2 4   n 5 2   o 8 1   p 2 4   q 1 10  r 6 1
  s 5 1   t 7 1   u 4 2   v 2 5   w 2 4   x 1 8   y 2 3   z 1 10  ? 2 0`;

function table(text: string): Record<string, { count: number; points: number }> {
  const cells = text.trim().split(/\s+/u);
  const tiles: Record<string, { count: number; points: number }> = {};
  for (let i = 0; i < cells.length; i += 3) {
    tiles[cells[i]!] = { count: Number(cells[i + 1]), points: Number(cells[i + 2]) };
  }
  return tiles;
}

function ruleset(id: string): Ruleset {
  const found = latestRuleset(id);
  if (found === undefined) throw new Error(`no ruleset ${id}`);
  return found;
}

/**
 * How many times two premium squares sit one square apart (`X.X`) in a row or column: a design
 * limit on the MVP layouts (M1b review P2-1), not a schema rule.
 */
function gapOnePairs(premiums: readonly string[]): number {
  const columns = premiums.map((_, col) => premiums.map((line) => line[col] ?? ".").join(""));
  let pairs = 0;
  for (const line of [...premiums, ...columns]) {
    for (let i = 0; i + 2 < line.length; i += 1) {
      if (line[i] !== "." && line[i + 2] !== ".") pairs += 1;
    }
  }
  return pairs;
}

/** words §8.3: every field of each MVP ruleset. */
const MVP = [
  {
    id: "classic",
    name: "Classic",
    tiles: TABLE_A,
    total: 100,
    startPremium: "D",
    premiums: { TW: 8, DW: 17, TL: 12, DL: 24 },
    maxUpTo7: 4,
    opening: 2,
    bingoBonus: 50,
    swapOrder: "drawThenReturn",
  },
  {
    id: "casual",
    name: "Casual",
    tiles: TABLE_B,
    total: 104,
    startPremium: ".",
    premiums: { TW: 8, DW: 12, TL: 16, DL: 24 },
    maxUpTo7: 3,
    opening: 1,
    bingoBonus: 35,
    swapOrder: "returnThenDraw",
  },
] as const;

describe.each(MVP)("ruleset $id (words §8.3)", (expected) => {
  const r = ruleset(expected.id);

  it("is version 1 with its neutral display name and English", () => {
    expect(r.version).toBe(1);
    expect(r.name).toBe(expected.name);
    expect(r.language).toBe("en");
  });

  it("matches its tile table exactly", () => {
    expect(r.tiles).toStrictEqual(table(expected.tiles));
    expect(totalTiles(r)).toBe(expected.total);
    expect(r.tiles["?"]).toStrictEqual({ count: 2, points: 0 });
    expect(Object.keys(r.tiles)).toHaveLength(27);
  });

  it("has the board, rack, bonus and turn numbers of the table", () => {
    expect(r.boardSize).toBe(15);
    expect(r.start).toStrictEqual([7, 7]);
    expect(r.rackSize).toBe(7);
    expect(r.bingoBonus).toBe(expected.bingoBonus);
    expect(r.swapOrder).toBe(expected.swapOrder);
    expect(r.swapMinBag).toBe(7);
    expect(r.scorelessTurnLimit).toBe(6);
    expect([r.minPlayers, r.maxPlayers]).toStrictEqual([2, 2]);
  });

  it("has the premium counts documented in its file, the start square included", () => {
    expect(premiumCounts(r.premiums)).toStrictEqual(expected.premiums);
    expect(r.premiums[7]?.[7]).toBe(expected.startPremium);
  });

  it("has a premium layout symmetric under a quarter turn", () => {
    expect(isQuarterTurnSymmetric(r.premiums)).toBe(true);
  });

  it("has no two premium squares side by side, the start square included", () => {
    expect(adjacentPremiums(r.premiums)).toStrictEqual([]);
  });

  it("is not symmetric under a mirror, as the reference boards are (words §8.3, Q15)", () => {
    // Under quarter-turn symmetry one mirror symmetry implies all four, so one check covers them.
    const mirrored = r.premiums.map((row) =>
      Array.from({ length: row.length }, (_, col) => row.charAt(row.length - 1 - col)).join(""),
    );
    expect(mirrored).not.toStrictEqual(r.premiums);
  });

  it("never lets a short word stack word multipliers (M1b review P2-1, issue #10 R-2)", () => {
    expect(closestWordPremiums(r.premiums)).toBeGreaterThanOrEqual(MIN_WORD_PREMIUM_DISTANCE);
    // The cap is the reference boards' own limit: ×4 up to 7 letters.
    expect(WORD_MULTIPLIER_CAP).toStrictEqual({ maxLength: 7, max: 4 });
    expect(maxWordMultiplier(r.premiums, 7)).toBe(expected.maxUpTo7);
  });

  it("gives an opening word no more than the start square's own multiplier (issue #10 R-1)", () => {
    expect(openingMultiplierLimit(r.premiums, r.start)).toBe(expected.opening);
    expect(openingWordMultiplier(r.premiums, r.start, r.rackSize)).toBe(expected.opening);
  });

  it("keeps letter premiums from clustering: at most 12 X.X patterns (M1b review P2-1)", () => {
    expect(gapOnePairs(r.premiums)).toBeLessThanOrEqual(12);
  });

  it("is deep-frozen, so no game can change the shared copy", () => {
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.tiles)).toBe(true);
    expect(Object.isFrozen(r.tiles["a"])).toBe(true);
    expect(Object.isFrozen(r.premiums)).toBe(true);
    expect(Object.isFrozen(r.start)).toBe(true);
    expect(() => {
      (r.tiles as Record<string, { count: number }>)["a"]!.count = 99;
    }).toThrow(TypeError);
  });
});

it("registers exactly the two MVP rulesets, one version each", () => {
  expect([...RULESETS.keys()]).toStrictEqual(["classic", "casual"]);
  expect(findRuleset("classic", 1)).toBe(ruleset("classic"));
  expect(findRuleset("classic", 2)).toBeUndefined();
  expect(findRuleset("nope", 1)).toBeUndefined();
  expect(latestRuleset("nope")).toBeUndefined();
});

it("keeps the two MVP layouts different from each other", () => {
  expect(ruleset("classic").premiums).not.toStrictEqual(ruleset("casual").premiums);
});

it("has each ruleset module export exactly its one ruleset, which is what is registered", () => {
  for (const [module, name, id] of [
    [classicModule, "classicV1", "classic"],
    [casualModule, "casualV1", "casual"],
  ] as const) {
    expect(Object.keys(module)).toStrictEqual([name]);
    expect(rulesetSchema.parse(Object.values(module)[0])).toStrictEqual(ruleset(id));
  }
});

it("caps the board at the dictionaries' longest word, so the two move together (words §9.1)", () => {
  expect(MAX_BOARD_SIZE).toBe(MAX_WORD_LENGTH);
});

describe("premium helpers", () => {
  it("rotates a picture a quarter turn clockwise", () => {
    expect(rotatePremiums(["ab", "cd"])).toStrictEqual(["ca", "db"]);
    expect(
      rotatePremiums(rotatePremiums(rotatePremiums(rotatePremiums(["abc", "def", "ghi"])))),
    ).toStrictEqual(["abc", "def", "ghi"]);
  });

  it.each([
    { premiums: ["T.T", "...", "T.T"], symmetric: true },
    { premiums: ["d..", "...", "..d"], symmetric: false },
    // Symmetric under a half turn and both mirrors' composition, but not a quarter turn.
    { premiums: [".d.", "...", ".d."], symmetric: false },
    { premiums: [".d.", "d.d", ".d."], symmetric: true },
  ])("$premiums is quarter-turn symmetric: $symmetric", ({ premiums, symmetric }) => {
    expect(isQuarterTurnSymmetric(premiums)).toBe(symmetric);
  });

  it.each([
    { premiums: ["d.d", ".D.", "d.d"], adjacent: [] },
    {
      premiums: [".d.", "dDd", ".d."],
      adjacent: [
        [0, 1],
        [1, 0],
        [1, 1],
      ],
    },
    { premiums: ["Tt", ".."], adjacent: [[0, 0]] },
    { premiums: ["T.", "t."], adjacent: [[0, 0]] },
    { premiums: ["T.", ".t"], adjacent: [] },
  ])("$premiums has adjacent premiums at $adjacent", ({ premiums, adjacent }) => {
    expect(adjacentPremiums(premiums)).toStrictEqual(adjacent);
  });

  it.each([
    { premiums: ["D...D", ".....", "....."], closest: 4 },
    { premiums: ["D..T.", ".....", "....."], closest: 3 },
    { premiums: ["d.d.d", ".....", "....."], closest: Number.POSITIVE_INFINITY },
    { premiums: ["D....", ".....", "T...."], closest: 2 },
    { premiums: ["D.....", "......", "......", ".....T", "......", "D....."], closest: 5 },
  ])("$premiums has word premiums $closest apart at the closest", ({ premiums, closest }) => {
    expect(closestWordPremiums(premiums)).toBe(closest);
  });

  it.each([
    { line: "D...D....T", length: 2, max: 3 },
    { line: "D...D....T", length: 4, max: 3 },
    { line: "D...D....T", length: 5, max: 4 },
    { line: "D...D....T", length: 6, max: 6 },
    { line: "D...D....T", length: 10, max: 12 },
    { line: "d.t.....", length: 8, max: 1 },
    { line: "T.T", length: 9, max: 9 },
  ])("$line: a word of $length letters covers at most ×$max", ({ line, length, max }) => {
    expect(maxWordMultiplier([line], length)).toBe(max);
  });

  it.each<{ premiums: string[]; start: [number, number]; length: number; max: number }>([
    { premiums: ["D...D...D"], start: [0, 4], length: 4, max: 2 },
    { premiums: ["D...D...D"], start: [0, 4], length: 5, max: 4 },
    { premiums: ["D..D"], start: [0, 0], length: 3, max: 2 },
    { premiums: ["D..D"], start: [0, 0], length: 4, max: 4 },
    { premiums: ["D..D"], start: [0, 3], length: 4, max: 4 },
    { premiums: ["T", ".", ".", "D"], start: [3, 0], length: 3, max: 2 },
    { premiums: ["T", ".", ".", "D"], start: [3, 0], length: 4, max: 6 },
    // Only the start square's own row and column count: the TW is on neither.
    { premiums: ["T..", "...", "..D"], start: [2, 2], length: 3, max: 2 },
    { premiums: ["d.t.d"], start: [0, 2], length: 5, max: 1 },
  ])(
    "$premiums: an opening of up to $length letters through $start covers at most ×$max",
    ({ premiums, start, length, max }) => {
      expect(openingWordMultiplier(premiums, start, length)).toBe(max);
    },
  );

  it.each([
    { start: "D", limit: 2 },
    { start: "T", limit: MAX_OPENING_MULTIPLIER },
    { start: "d", limit: 1 },
    { start: "t", limit: 1 },
    { start: ".", limit: 1 },
  ])("lets an opening through a start square of $start cover ×$limit", ({ start, limit }) => {
    expect(openingMultiplierLimit([`.${start}.`], [0, 1])).toBe(limit);
  });

  it("counts X.X patterns in rows and columns", () => {
    expect(gapOnePairs(["d.d", "...", "d.D"])).toBe(4);
    expect(gapOnePairs(["d..d", "....", "....", "d..d"])).toBe(0);
    expect(gapOnePairs(["d.t.d"])).toBe(2);
  });

  it("counts each premium code", () => {
    expect(premiumCounts(["Tt", "Dd"])).toStrictEqual({ TW: 1, TL: 1, DW: 1, DL: 1 });
    expect(premiumCounts([".."])).toStrictEqual({ TW: 0, TL: 0, DW: 0, DL: 0 });
  });
});

/** A small valid ruleset to break one rule at a time. */
function small(): RulesetData {
  return {
    id: "tiny",
    version: 1,
    name: "Tiny",
    description: "A test ruleset.",
    language: "en",
    boardSize: 3,
    start: [1, 1],
    rackSize: 2,
    bingoBonus: 10,
    swapMinBag: 2,
    swapOrder: "drawThenReturn",
    scorelessTurnLimit: 4,
    minPlayers: 2,
    maxPlayers: 2,
    tiles: { a: { count: 3, points: 1 }, "?": { count: 1, points: 0 } },
    premiums: ["d.d", ".D.", "d.d"],
  };
}

describe("ruleset schema (words §8.2)", () => {
  it("accepts the small valid ruleset", () => {
    expect(rulesetSchema.safeParse(small()).success).toBe(true);
  });

  it.each<[string, (r: RulesetData) => RulesetData, string]>([
    [
      "a tile letter outside a–z and ?",
      (r) => ({ ...r, tiles: { ...r.tiles, A: { count: 1, points: 1 } } }),
      "tiles",
    ],
    [
      "a multi-character tile code",
      (r) => ({ ...r, tiles: { ...r.tiles, ab: { count: 1, points: 1 } } }),
      "tiles",
    ],
    [
      "a negative count",
      (r) => ({ ...r, tiles: { ...r.tiles, a: { count: -1, points: 1 } } }),
      "tiles",
    ],
    [
      "a fractional count",
      (r) => ({ ...r, tiles: { ...r.tiles, a: { count: 1.5, points: 1 } } }),
      "tiles",
    ],
    [
      "negative points",
      (r) => ({ ...r, tiles: { ...r.tiles, a: { count: 3, points: -2 } } }),
      "tiles",
    ],
    [
      "a blank worth points",
      (r) => ({ ...r, tiles: { ...r.tiles, "?": { count: 1, points: 1 } } }),
      "tiles",
    ],
    [
      "fewer tiles than full racks",
      (r) => ({ ...r, tiles: { a: { count: 3, points: 1 } } }),
      "tiles",
    ],
    ["too few premium rows", (r) => ({ ...r, premiums: [".d.", "dDd"] }), "premiums"],
    [
      "a premium row of the wrong length",
      (r) => ({ ...r, premiums: [".d.", "dDd.", ".d."] }),
      "premiums",
    ],
    ["an unknown premium code", (r) => ({ ...r, premiums: [".x.", "dDd", ".x."] }), "premiums"],
    ["an asymmetric layout", (r) => ({ ...r, premiums: ["T.d", ".D.", "d.d"] }), "premiums"],
    [
      "premiums side by side (here the start square and a DL)",
      (r) => ({ ...r, premiums: [".d.", "dDd", ".d."] }),
      "premiums",
    ],
    ["a start square off the board", (r) => ({ ...r, start: [3, 1] }), "start"],
    ["a board above the dictionaries' longest word", (r) => ({ ...r, boardSize: 16 }), "boardSize"],
    ["a rack longer than the board", (r) => ({ ...r, rackSize: 4, swapMinBag: 4 }), "rackSize"],
    [
      "drawThenReturn with too small a swap minimum",
      (r) => ({ ...r, swapMinBag: 1 }),
      "swapMinBag",
    ],
    ["maxPlayers below minPlayers", (r) => ({ ...r, minPlayers: 3, maxPlayers: 2 }), "maxPlayers"],
    ["one player", (r) => ({ ...r, minPlayers: 1 }), "minPlayers"],
    ["three players (words §3.4)", (r) => ({ ...r, maxPlayers: 3 }), "maxPlayers"],
    [
      "an unknown swap order",
      (r) => ({ ...r, swapOrder: "swapThenPray" as "drawThenReturn" }),
      "swapOrder",
    ],
    ["a scoreless limit of 0", (r) => ({ ...r, scorelessTurnLimit: 0 }), "scorelessTurnLimit"],
    ["an id that isn't a slug", (r) => ({ ...r, id: "Tiny Rules" }), "id"],
    ["version 0", (r) => ({ ...r, version: 0 }), "version"],
    ["an empty name", (r) => ({ ...r, name: "" }), "name"],
    ["a language that isn't a tag", (r) => ({ ...r, language: "English" }), "language"],
    ["an unknown field", (r) => ({ ...r, powerUps: true }) as RulesetData, ""],
  ])("rejects %s", (_name, breakIt, path) => {
    const result = rulesetSchema.safeParse(breakIt(small()));
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => (issue.path[0] ?? "") === path)).toBe(true);
  });

  it.each<[string, number, string[], RegExp]>([
    [
      "word premiums two squares apart",
      5,
      ["D.D.D", ".....", "D...D", ".....", "D.D.D"],
      /word premiums in one row or column must be at least 4 squares apart/u,
    ],
    [
      "a 5-letter word covering two TWs",
      5,
      ["T...T", ".....", ".....", ".....", "T...T"],
      /7 letters or fewer may cover at most ×4/u,
    ],
    [
      "a 7-letter word covering two TWs",
      7,
      ["T.....T", ".......", ".......", ".......", ".......", ".......", "T.....T"],
      /7 letters or fewer may cover at most ×4/u,
    ],
  ])("rejects %s (M1b review P2-1)", (_name, boardSize, premiums, message) => {
    const result = rulesetSchema.safeParse({ ...small(), boardSize, start: [2, 2], premiums });
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages.some((text) => message.test(text))).toBe(true);
  });

  /** A 9×9 ruleset with a full rack of `rackSize`, valid but for what `premiums` breaks. */
  function nine(premiums: string[], rackSize: number): RulesetData {
    return {
      ...small(),
      boardSize: 9,
      start: [4, 4],
      rackSize,
      swapMinBag: rackSize,
      tiles: { a: { count: 2 * rackSize, points: 1 } },
      premiums,
    };
  }

  // A TW and a DW six squares apart in rows 0 and 8 and columns 0 and 8.
  const TW_DW_SIX_APART = [
    ".T.....D.",
    "D.......T",
    ".........",
    ".........",
    ".........",
    ".........",
    ".........",
    "T.......D",
    ".D.....T.",
  ];
  // DWs at the ends of row 4 and column 4, four squares from the start square.
  const DW_FOUR_FROM_START = (start: string): string[] => [
    "....D....",
    ".........",
    ".........",
    ".........",
    `D...${start}...D`,
    ".........",
    ".........",
    ".........",
    "....D....",
  ];
  // DWs in row 4 and column 4, three squares from a plain start square.
  const DW_THREE_FROM_START = [
    ".........",
    "....D....",
    ".........",
    ".........",
    ".D.....D.",
    ".........",
    ".........",
    "....D....",
    ".........",
  ];

  it.each<[string, RulesetData, string]>([
    [
      "a TW and a DW in one 7-letter word (×6)",
      nine(TW_DW_SIX_APART, 2),
      "a word of 7 letters or fewer may cover at most ×4",
    ],
    [
      "an opening covering a second DW with the start square's (×4)",
      nine(DW_FOUR_FROM_START("D"), 7),
      "a word through the start square of 7 letters or fewer may cover at most ×2",
    ],
    [
      "an opening covering a DW from a plain start square (×2)",
      nine(DW_THREE_FROM_START, 7),
      "a word through the start square of 7 letters or fewer may cover at most ×1",
    ],
    [
      "an opening covering a DW from a letter-premium start square (×2)",
      nine(DW_FOUR_FROM_START("d"), 5),
      "a word through the start square of 5 letters or fewer may cover at most ×1",
    ],
    [
      "a TW start square (×3)",
      { ...small(), premiums: ["d.d", ".T.", "d.d"] },
      "a word through the start square of 2 letters or fewer may cover at most ×2",
    ],
  ])("rejects %s, and only for that (issue #10)", (_name, data, message) => {
    const result = rulesetSchema.safeParse(data);
    expect(result.error?.issues.map((issue) => [issue.path, issue.message])).toStrictEqual([
      [["premiums"], message],
    ]);
  });

  it.each<[string, RulesetData]>([
    ["two DWs six apart, ×4 in 7 letters", nine(DW_THREE_FROM_START, 2)],
    ["a second DW just beyond a full rack's reach", nine(DW_FOUR_FROM_START("D"), 4)],
    ["a DW just beyond a full rack's reach of a plain start", nine(DW_FOUR_FROM_START("."), 4)],
  ])("accepts %s (issue #10)", (_name, data) => {
    expect(rulesetSchema.safeParse(data).success).toBe(true);
  });

  it("keeps a valid board whose word premiums are 4 apart and cover ×4 at most", () => {
    const premiums = ["D...D", ".....", "..d..", ".....", "D...D"];
    expect(
      rulesetSchema.safeParse({ ...small(), boardSize: 5, start: [2, 2], premiums }).success,
    ).toBe(true);
  });

  it("allows returnThenDraw with a swap minimum below the rack size", () => {
    const r = { ...small(), swapOrder: "returnThenDraw" as const, swapMinBag: 0 };
    expect(rulesetSchema.safeParse(r).success).toBe(true);
  });
});

describe("createRegistry", () => {
  it("numbers versions from 1 and returns the latest", () => {
    const registry = createRegistry({
      tiny: [small(), { ...small(), version: 2, bingoBonus: 20 }],
    });
    expect(latestRuleset("tiny", registry)?.bingoBonus).toBe(20);
    expect(findRuleset("tiny", 1, registry)?.bingoBonus).toBe(10);
  });

  it.each<[string, Record<string, RulesetData[]>, RegExp]>([
    ["an id with no versions", { tiny: [] }, /no versions/u],
    ["a version out of order", { tiny: [{ ...small(), version: 2 }] }, /must be tiny v1/u],
    ["an id under the wrong key", { other: [small()] }, /must be other v1/u],
    ["an invalid ruleset", { tiny: [{ ...small(), boardSize: 99 }] }, /tiny v1 is invalid/u],
  ])("refuses %s", (_name, data, message) => {
    expect(() => createRegistry(data)).toThrow(message);
  });
});
