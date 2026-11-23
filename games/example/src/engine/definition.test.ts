import { RESERVED_ERROR_CODES } from "@your-move/sdk";
import { describe, expect, it } from "vitest";

import { OPTIONS } from "../test-support.js";
import { at } from "./at.js";
import { engines } from "./index.js";

const game = engines[1];

describe("the version 1 definition (02 §2)", () => {
  it("is rules version 1 of the example type", () => {
    expect(game.type).toBe("example");
    expect(game.version).toBe(1);
  });

  it("declares its creation hooks", () => {
    expect(game.players(OPTIONS)).toEqual({ min: 2, max: 4 });
    expect(game.defaultTurnTimeoutDays(OPTIONS)).toBe(3);
    expect(game.resources(OPTIONS)).toEqual([]);
    expect(game.checkConfig({}, [])).toEqual({ ok: true });
    expect(game.resolveOptions({ lives: 3 }, { config: {}, resources: [] })).toEqual({
      handSize: 3,
      lives: 3,
    });
    expect(game.catalogSchema.parse(game.catalog({ config: {}, resources: [] }))).toBeTruthy();
  });

  it("takes no configuration (02 §2.1 rule 8)", () => {
    expect(game.configSchema.safeParse({}).success).toBe(true);
    expect(game.configSchema.safeParse({ DECK: "40" }).success).toBe(false);
  });

  it("lists unique, unreserved error codes (02 §2.2)", () => {
    expect(new Set(game.errorCodes).size).toBe(game.errorCodes.length);
    for (const code of game.errorCodes) expect(RESERVED_ERROR_CODES).not.toContain(code);
  });

  it("is plain JSON data from setup on (02 §5)", () => {
    const s = game.setup({ options: OPTIONS, seats: 2, rng: { nextInt: () => 0 } });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe("at", () => {
  it("reads an element and throws outside the array", () => {
    expect(at([4, 5], 1)).toBe(5);
    expect(() => at([4, 5], 2)).toThrow(/out of range/u);
    expect(() => at([4, 5], -1)).toThrow(/out of range/u);
  });
});
