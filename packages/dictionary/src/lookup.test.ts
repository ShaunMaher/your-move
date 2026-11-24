import { array, assert, property, stringMatching } from "fast-check";
import { describe, expect, it } from "vitest";

import { formatWordList } from "./format.js";
import { createWordList, hasWord } from "./lookup.js";

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
});

describe("createWordList", () => {
  it("is the engine's dictionary resource: id, version and has()", () => {
    const list = createWordList("tiny", 3, LIST);
    expect(list.id).toBe("tiny");
    expect(list.version).toBe(3);
    expect(list.has("cat")).toBe(true);
    expect(list.has("dog")).toBe(false);
  });
});
