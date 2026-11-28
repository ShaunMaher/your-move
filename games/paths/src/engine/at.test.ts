import { describe, expect, it } from "vitest";

import { at } from "./at.js";

describe("at", () => {
  it("returns an element in range and throws for any other index, an engine bug", () => {
    expect(at(["a", "b"], 1)).toBe("b");
    expect(() => at(["a"], 1)).toThrow(RangeError);
    expect(() => at(["a"], -1)).toThrow(RangeError);
    expect(() => at(["a"], 0.5)).toThrow(RangeError);
  });
});
