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
  maxWordMultiplier,
  MIN_WORD_PREMIUM_DISTANCE,
  WORD_MULTIPLIER_CAPS,
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

/** words §8.3: every field of each MVP ruleset. */
const MVP = [
  {
    id: "classic",
    name: "Classic",
    tiles: TABLE_A,
    total: 100,
    startPremium: "D",
    premiums: { TW: 8, DW: 17, TL: 12, DL: 24 },
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

  it("never lets a short word stack word multipliers (M1b review P2-1)", () => {
    expect(closestWordPremiums(r.premiums)).toBeGreaterThanOrEqual(MIN_WORD_PREMIUM_DISTANCE);
    // The caps are the reference boards' own limits: ×4 up to 6 letters, ×6 at 7.
    expect(WORD_MULTIPLIER_CAPS).toStrictEqual([
      { maxLength: 6, max: 4 },
      { maxLength: 7, max: 6 },
    ]);
    for (let length = 2; length <= 6; length += 1) {
      expect(maxWordMultiplier(r.premiums, length)).toBeLessThanOrEqual(4);
    }
    expect(maxWordMultiplier(r.premiums, 7)).toBeLessThanOrEqual(6);
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
      /6 letters or fewer may cover at most ×4/u,
    ],
    [
      "a 7-letter word covering two TWs",
      7,
      ["T.....T", ".......", ".......", ".......", ".......", ".......", "T.....T"],
      /7 letters or fewer may cover at most ×6/u,
    ],
  ])("rejects %s (M1b review P2-1)", (_name, boardSize, premiums, message) => {
    const result = rulesetSchema.safeParse({ ...small(), boardSize, start: [2, 2], premiums });
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages.some((text) => message.test(text))).toBe(true);
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
