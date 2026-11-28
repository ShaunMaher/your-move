import { describe, expect, it } from "vitest";

import { catalog, resolveOptions } from "./options.js";
import { catalogSchema, optionsSchema } from "./schemas.js";

const DEFAULTS = { boardSize: 6, handSize: 3, selfElimination: "avoidIfPossible" };

describe("resolveOptions (paths §6)", () => {
  it.each([undefined, null, {}])("fills in every default from %s", (input) => {
    expect(resolveOptions(input)).toEqual(DEFAULTS);
  });

  it("takes each option given", () => {
    expect(resolveOptions({ handSize: 1, selfElimination: "allowed", boardSize: 6 })).toEqual({
      boardSize: 6,
      handSize: 1,
      selfElimination: "allowed",
    });
    expect(resolveOptions({ handSize: 2, selfElimination: undefined })).toEqual({
      ...DEFAULTS,
      handSize: 2,
    });
  });

  it("resolves its own output to itself (02 §2.1 rule 10)", () => {
    for (const input of [{}, { handSize: 1 }, { selfElimination: "allowed" }]) {
      const resolved = resolveOptions(input);
      expect(optionsSchema.parse(resolved)).toEqual(resolved);
      expect(resolveOptions(resolved)).toEqual(resolved);
    }
  });

  it.each([[[]], ["paths"], [3]])("refuses an input that isn't an object: %j", (input) => {
    expect(resolveOptions(input)).toEqual({ code: "OPTIONS_NOT_OBJECT" });
  });

  it("names an unknown option only when the key looks like an option name", () => {
    expect(resolveOptions({ teams: true })).toEqual({
      code: "UNKNOWN_OPTION",
      detail: { option: "teams" },
    });
    expect(resolveOptions({ "<script>": 1 })).toEqual({ code: "UNKNOWN_OPTION" });
    expect(resolveOptions({ boardSizeVersion: 1 })).toEqual({
      code: "UNKNOWN_OPTION",
      detail: { option: "boardSizeVersion" },
    });
  });

  it.each<[string, unknown]>([
    ["boardSize", 8],
    ["boardSize", "6"],
    ["handSize", 0],
    ["handSize", 4],
    ["handSize", 2.5],
    ["handSize", "3"],
    ["selfElimination", "never"],
    ["selfElimination", true],
  ])("refuses %s = %j", (option, value) => {
    expect(resolveOptions({ [option]: value })).toEqual({
      code: "INVALID_OPTION",
      detail: { option },
    });
  });
});

describe("catalog (paths §6)", () => {
  it("lists the option values and defaults", () => {
    const listed = catalog();
    expect(catalogSchema.parse(listed)).toEqual(listed);
    expect(listed).toEqual({
      boardSize: { values: [6], default: 6 },
      handSize: { min: 1, max: 3, default: 3 },
      selfElimination: { values: ["avoidIfPossible", "allowed"], default: "avoidIfPossible" },
      tiles: 35,
    });
  });
});
