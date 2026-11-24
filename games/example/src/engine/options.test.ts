import { RESERVED_ERROR_CODES } from "@your-move/sdk";
import { describe, expect, it } from "vitest";

import { catalog, resolveOptions, validateStart } from "./options.js";
import { catalogSchema, ERROR_CODES, optionsSchema } from "./schemas.js";

describe("resolveOptions (02 §2)", () => {
  it.each([
    ["no input", undefined, { handSize: 3, lives: 2 }],
    ["null", null, { handSize: 3, lives: 2 }],
    ["an empty object", {}, { handSize: 3, lives: 2 }],
    ["a hand size", { handSize: 6 }, { handSize: 6, lives: 2 }],
    ["lives", { lives: 1 }, { handSize: 3, lives: 1 }],
    ["both", { handSize: 4, lives: 3 }, { handSize: 4, lives: 3 }],
    ["an explicit undefined", { handSize: undefined }, { handSize: 3, lives: 2 }],
  ])("fills defaults for %s", (_, input, expected) => {
    const options = resolveOptions(input);
    expect(options).toEqual(expected);
    expect(optionsSchema.parse(options)).toEqual(expected);
  });

  it.each([
    ["a string", "big", { code: ERROR_CODES.optionsNotObject }],
    ["a number", 3, { code: ERROR_CODES.optionsNotObject }],
    ["an array", [3], { code: ERROR_CODES.optionsNotObject }],
    ["an unknown key", { deck: 10 }, { code: "UNKNOWN_OPTION", detail: { option: "deck" } }],
    [
      "a hand size too big",
      { handSize: 7 },
      { code: "OPTION_OUT_OF_RANGE", detail: { option: "handSize", min: 3, max: 6 } },
    ],
    [
      "no lives",
      { lives: 0 },
      { code: "OPTION_OUT_OF_RANGE", detail: { option: "lives", min: 1, max: 3 } },
    ],
    [
      "a fraction",
      { handSize: 3.5 },
      { code: "OPTION_OUT_OF_RANGE", detail: { option: "handSize", min: 3, max: 6 } },
    ],
    [
      "a numeric string",
      { lives: "2" },
      { code: "OPTION_OUT_OF_RANGE", detail: { option: "lives", min: 1, max: 3 } },
    ],
    [
      "an inherited key",
      JSON.parse('{"__proto__": 1}') as unknown,
      { code: "UNKNOWN_OPTION", detail: { option: "__proto__" } },
    ],
  ])("refuses %s", (_, input, expected) => {
    expect(resolveOptions(input)).toEqual(expected);
  });

  it("never returns a reserved code", () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(RESERVED_ERROR_CODES).not.toContain(code);
    }
  });
});

describe("catalog", () => {
  it("lists the ranges and defaults, matching its schema", () => {
    const value = catalog();
    expect(catalogSchema.parse(value)).toEqual({
      deckSize: 20,
      handSize: { min: 3, max: 6, default: 3 },
      lives: { min: 1, max: 3, default: 2 },
    });
  });
});

describe("validateStart (02 §2)", () => {
  it.each([
    [3, 2, true],
    [3, 4, true],
    [5, 4, true],
    [6, 3, true],
    [6, 4, false],
  ])("hand size %i with %i seats: ok=%s", (handSize, seats, ok) => {
    const answer = validateStart({ handSize, lives: 2 }, seats);
    if (ok) expect(answer).toEqual({ ok: true });
    else expect(answer).toEqual({ code: "DECK_TOO_SMALL", detail: { needed: 24, deckSize: 20 } });
  });
});
