import { describe, expect, it } from "vitest";

import { OK, RESERVED_ERROR_CODES, isGameError } from "./contract.js";

describe("isGameError", () => {
  it.each([
    [{ code: "X" }, true],
    [{ code: "X", detail: { a: 1 } }, true],
    [{ code: "X", detail: undefined }, true],
    [{ code: 1 }, false],
    [{ code: "X", other: 1 }, false],
    [OK, false],
    [null, false],
    ["X", false],
    [["X"], false],
    [{}, false],
  ])("%j → %s", (value, expected) => {
    expect(isGameError(value)).toBe(expected);
  });
});

describe("reserved codes", () => {
  it("includes the framework codes (05 §Errors)", () => {
    for (const code of ["NOT_FOUND", "NOT_YOUR_TURN", "INVALID_ACTION", "STALE_GAME", "INTERNAL"]) {
      expect(RESERVED_ERROR_CODES).toContain(code);
    }
  });

  it("is frozen, as is OK", () => {
    expect(Object.isFrozen(RESERVED_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(OK)).toBe(true);
  });
});
