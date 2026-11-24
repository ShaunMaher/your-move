import { describe, expect, it } from "vitest";

import { checkWordList, formatWordList, isWord } from "./format.js";

describe("isWord (words §9.1)", () => {
  it.each([
    ["aa", true],
    ["quiz", true],
    ["abcdefghijklmno", true],
    ["a", false],
    ["abcdefghijklmnop", false],
    ["", false],
    ["Quiz", false],
    ["don't", false],
    ["café", false],
    ["two words", false],
    ["qu?z", false],
  ])("%j → %s", (word, valid) => {
    expect(isWord(word)).toBe(valid);
  });
});

describe("checkWordList", () => {
  it("accepts a sorted list and reports its count and alphabet", () => {
    expect(checkWordList("ab\nba\nzz\n")).toStrictEqual({
      ok: true,
      wordCount: 3,
      alphabet: ["a", "b", "z"],
    });
  });

  it.each([
    ["", "EMPTY", 0],
    ["ab\nba", "NO_FINAL_NEWLINE", 0],
    ["ab\n\nba\n", "BAD_CHARACTERS", 2],
    ["ab\nBa\n", "BAD_CHARACTERS", 2],
    ["ab\nb a\n", "BAD_CHARACTERS", 2],
    ["ab\r\nba\r\n", "BAD_CHARACTERS", 1],
    ["ab\nb\n", "BAD_LENGTH", 2],
    ["ab\nabcdefghijklmnop\n", "BAD_LENGTH", 2],
    ["ba\nab\n", "NOT_SORTED", 2],
    ["ab\nab\n", "NOT_SORTED", 2],
  ])("rejects %j: %s at line %d", (text, problem, line) => {
    expect(checkWordList(text)).toStrictEqual({ ok: false, problem, line });
  });
});

describe("formatWordList", () => {
  it("sorts by code unit, removes duplicates and ends with a newline", () => {
    expect(formatWordList(["zz", "ab", "ba", "ab"])).toBe("ab\nba\nzz\n");
  });

  it("formats no words as the empty text", () => {
    expect(formatWordList([])).toBe("");
  });

  it("produces what checkWordList accepts", () => {
    expect(checkWordList(formatWordList(["quiz", "aa", "zyzzyva"])).ok).toBe(true);
  });
});
