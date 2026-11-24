import { describe, expect, it } from "vitest";

import { isCompatible, missingLetters, type DictionaryTraits } from "./compatibility.js";
import { latestRuleset } from "./rulesets/index.js";
import type { Ruleset } from "./rulesets/schema.js";

const ALPHABET = Array.from({ length: 26 }, (_, index) => String.fromCharCode(97 + index));

function classic(): Ruleset {
  const ruleset = latestRuleset("classic");
  if (ruleset === undefined) throw new Error("classic is registered");
  return ruleset;
}

/** classic with one letter's tiles changed, or removed when `count` is undefined. */
function withTile(letter: string, count: number | undefined): Ruleset {
  const base = classic();
  const others = Object.entries(base.tiles).filter(([code]) => code !== letter);
  const tiles = Object.fromEntries(
    count === undefined ? others : [...others, [letter, { count, points: 1 }]],
  );
  return { ...base, tiles };
}

describe("ruleset ↔ dictionary compatibility (words §9.3)", () => {
  it.each<[string, Ruleset, DictionaryTraits, boolean, string[]]>([
    ["same language, full alphabet", classic(), { language: "en", alphabet: ALPHABET }, true, []],
    [
      "same language, smaller alphabet",
      classic(),
      { language: "en", alphabet: ["a", "b"] },
      true,
      [],
    ],
    ["same language, empty alphabet", classic(), { language: "en", alphabet: [] }, true, []],
    ["a different language", classic(), { language: "fr", alphabet: ["a"] }, false, []],
    [
      "a regional tag isn't the same language",
      classic(),
      { language: "en-AU", alphabet: ["a"] },
      false,
      [],
    ],
    [
      "a letter with no tile entry",
      withTile("q", undefined),
      { language: "en", alphabet: ALPHABET },
      false,
      ["q"],
    ],
    [
      "a letter whose tile count is 0",
      withTile("z", 0),
      { language: "en", alphabet: ALPHABET },
      false,
      ["z"],
    ],
    [
      "a missing letter the dictionary never uses",
      withTile("q", undefined),
      { language: "en", alphabet: ["a"] },
      true,
      [],
    ],
    ["a letter outside a–z", classic(), { language: "en", alphabet: ["a", "é"] }, false, ["é"]],
    [
      "an alphabet entry naming an object property",
      classic(),
      { language: "en", alphabet: ["constructor"] },
      false,
      ["constructor"],
    ],
  ])("%s", (_name, ruleset, dictionary, compatible, missing) => {
    expect(isCompatible(ruleset, dictionary)).toBe(compatible);
    expect(missingLetters(ruleset, dictionary)).toStrictEqual(missing);
  });

  it("finds both MVP rulesets compatible with an English a–z dictionary", () => {
    for (const id of ["classic", "casual"]) {
      const ruleset = latestRuleset(id);
      expect(ruleset && isCompatible(ruleset, { language: "en", alphabet: ALPHABET })).toBe(true);
    }
  });
});
