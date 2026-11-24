import { array, assert, constantFrom, oneof, property, string, stringMatching } from "fast-check";
import { describe, expect, it } from "vitest";

import { formatWordList } from "./format.js";
import { createWordList, hasWord, WordListFormatError } from "./lookup.js";

const LIST = formatWordList(["aa", "ab", "abs", "bat", "bath", "bats", "cat", "zyzzyva"]);

describe("hasWord (words §9.4)", () => {
  it.each([
    ["aa", true, "the first word"],
    ["zyzzyva", true, "the last word"],
    ["bat", true, "a word that prefixes others"],
    ["bath", true, "a word between its prefix and a sibling"],
    ["abs", true, "a word in the middle"],
    ["a", false, "too short to be a word"],
    ["aaa", false, "after the first word, before the second"],
    ["ba", false, "a prefix of words in the list"],
    ["bathe", false, "an extension of a word in the list"],
    ["ca", false, "a prefix of the next word"],
    ["zz", false, "after the last word"],
    ["Bat", false, "upper case is never a word"],
    ["bat\n", false, "a line break is never part of a word"],
    ["bat\ncat", false, "two lines are never one word"],
    ["", false, "the empty string"],
  ])("%j → %s (%s)", (word, found) => {
    expect(hasWord(LIST, word)).toBe(found);
  });

  it("finds nothing in an empty list", () => {
    expect(hasWord("", "aa")).toBe(false);
  });

  it("works on a one-word list", () => {
    const one = formatWordList(["qi"]);
    expect(hasWord(one, "qi")).toBe(true);
    expect(hasWord(one, "qa")).toBe(false);
    expect(hasWord(one, "qz")).toBe(false);
  });

  it("agrees with a Set on random lists and queries", () => {
    const word = stringMatching(/^[a-c]{2,5}$/u);
    assert(
      property(array(word, { maxLength: 60 }), array(word, { maxLength: 30 }), (words, queries) => {
        const text = formatWordList(words);
        const set = new Set(words);
        for (const query of [...words, ...queries]) {
          expect(hasWord(text, query)).toBe(set.has(query));
        }
      }),
      { seed: 20261124, numRuns: 300 },
    );
  });

  // M1b review P-1 / S-1: the last line of a text without its final newline used to loop forever.
  it.each([
    ["aa\nab\nzz", "zz", true],
    ["aa\nab\nzz", "zzz", false],
    ["aa\nab\nzz", "ac", false],
    ["aa", "aa", true],
    ["aa", "ab", false],
    ["aa", "a", false],
  ])("terminates on %j without a final newline: %j → %s", (text, word, found) => {
    expect(hasWord(text, word)).toBe(found);
  });

  // M1b review S2-1: a text starting with "\n" looped, since lastIndexOf treats -1 as 0.
  it.each([
    ["\nzz\n", "ab", false],
    ["\nzz\n", "zz", true],
    ["\n\n\n", "aa", false],
    ["\naa\nbb\n", "aa", true],
  ])("terminates on %j: %j → %s", (text, word, found) => {
    expect(hasWord(text, word)).toBe(found);
    expect(createWordList("x", 1, text).has(word)).toBe(found);
  });

  it("returns on arbitrary text, whatever it holds", () => {
    const text = oneof(
      string(),
      string({ unit: constantFrom("\n", "a", "b", "z", "\r", " ") }),
      array(stringMatching(/^[a-z]{0,4}$/u)).map((lines) => lines.join("\n")),
    );
    assert(
      property(text, stringMatching(/^[a-z]{2,4}$/u), (haystack, word) => {
        expect(typeof hasWord(haystack, word)).toBe("boolean");
      }),
      { seed: 20261126, numRuns: 2000 },
    );
  });

  it("terminates on any text, newline or not, and agrees with its lines", () => {
    const word = stringMatching(/^[a-c]{2,4}$/u);
    assert(
      property(array(word, { maxLength: 30 }), word, (words, query) => {
        const text = formatWordList(words).slice(0, -1);
        expect(hasWord(text, query)).toBe(new Set(words).has(query));
      }),
      { seed: 20261125, numRuns: 300 },
    );
  });
});

describe("createWordList", () => {
  it("is the engine's dictionary resource: id, version and has()", () => {
    const list = createWordList("tiny", 3, LIST);
    expect(list.id).toBe("tiny");
    expect(list.version).toBe(3);
    expect(list.has("cat")).toBe(true);
    expect(list.has("dog")).toBe(false);
    expect(Object.isFrozen(list)).toBe(true);
  });

  it("accepts the empty list", () => {
    expect(createWordList("none", 1, "").has("aa")).toBe(false);
  });

  it("refuses a text without its final newline", () => {
    expect(() => createWordList("tiny", 1, "aa\nab")).toThrow(WordListFormatError);
  });
});
