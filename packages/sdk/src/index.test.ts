import { describe, expect, it } from "vitest";

import { GAME_TYPE_PATTERN, isGameType } from "./index.js";

describe("isGameType", () => {
  it.each([
    ["words", true],
    ["paths", true],
    ["ab", true],
    ["a1", true],
    ["a".repeat(32), true],
    ["a", false],
    ["a".repeat(33), false],
    ["1abc", false],
    ["Words", false],
    ["my-game", false],
    ["my_game", false],
    ["", false],
    [" words", false],
    ["words\n", false],
  ])("%j → %s", (value, expected) => {
    expect(isGameType(value)).toBe(expected);
  });

  it("exposes the same rule as a pattern", () => {
    expect(GAME_TYPE_PATTERN.test("words")).toBe(true);
    expect(GAME_TYPE_PATTERN.flags).toBe("");
  });
});
