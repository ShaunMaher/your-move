import { describe, expect, it } from "vitest";

import { FACES } from "./faces.js";
import { catalog, resolveOptions } from "./options.js";
import { catalogSchema, ERROR_CODES, GRID_IDS, GRIDS, optionsSchema, PLAYERS } from "./schemas.js";

describe("resolveOptions (pairs §7)", () => {
  it.each([
    [undefined, { grid: "4x5" }],
    [null, { grid: "4x5" }],
    [{}, { grid: "4x5" }],
    [{ grid: "4x4" }, { grid: "4x4" }],
    [{ grid: "4x5" }, { grid: "4x5" }],
    [{ grid: "5x6" }, { grid: "5x6" }],
    [{ grid: "6x6" }, { grid: "6x6" }],
    [{ grid: undefined }, { grid: "4x5" }],
    [{ grid: null }, { grid: "4x5" }],
  ])("resolves %j to %j", (input, expected) => {
    expect(resolveOptions(input)).toEqual(expected);
    expect(optionsSchema.parse(expected)).toEqual(expected);
  });

  it("resolves resolved options to themselves (02 §2.1 rule 10)", () => {
    for (const grid of ["4x4", "4x5", "5x6", "6x6"] as const) {
      expect(resolveOptions(resolveOptions({ grid }))).toEqual({ grid });
    }
  });

  it.each([
    ["a string", "4x4", { code: "OPTIONS_NOT_OBJECT" }],
    ["a number", 4, { code: "OPTIONS_NOT_OBJECT" }],
    ["an array", [], { code: "OPTIONS_NOT_OBJECT" }],
    ["an unknown option", { size: 4 }, { code: "UNKNOWN_OPTION", detail: { option: "size" } }],
    [
      "a version key",
      { gridVersion: 1 },
      { code: "UNKNOWN_OPTION", detail: { option: "gridVersion" } },
    ],
    ["an unknown key that isn't a name", { "a b<": 1 }, { code: "UNKNOWN_OPTION" }],
    ["an over-long key", { ["k".repeat(65)]: 1 }, { code: "UNKNOWN_OPTION" }],
    ["another grid", { grid: "8x8" }, { code: "INVALID_OPTION", detail: { option: "grid" } }],
    ["the grid reversed", { grid: "5x4" }, { code: "INVALID_OPTION", detail: { option: "grid" } }],
    ["a grid number", { grid: 16 }, { code: "INVALID_OPTION", detail: { option: "grid" } }],
  ])("refuses %s", (_name, input, error) => {
    expect(resolveOptions(input)).toEqual(error);
  });
});

describe("catalog (pairs §7)", () => {
  it("lists the four grids, the default and the faces", () => {
    const value = catalog();
    expect(catalogSchema.parse(value)).toEqual(value);
    expect(value).toEqual({
      grid: { values: ["4x4", "4x5", "5x6", "6x6"], default: "4x5" },
      grids: [
        { id: "4x4", columns: 4, rows: 4, pairs: 8, moveLimit: 256 },
        { id: "4x5", columns: 4, rows: 5, pairs: 10, moveLimit: 400 },
        { id: "5x6", columns: 5, rows: 6, pairs: 15, moveLimit: 900 },
        { id: "6x6", columns: 6, rows: 6, pairs: 18, moveLimit: 1296 },
      ],
      faces: 18,
    });
  });

  it("accepts exactly the catalog of pairs §7, every value pinned", () => {
    const value = catalog();
    const [g44, g45, g56, g66] = value.grids;
    for (const changed of [
      { ...value, grids: value.grids.slice(1) },
      { ...value, grids: [g44, g45, g56, g66, g66] },
      { ...value, grids: [g44, g45, g56, { ...g66, moveLimit: 1295 }] },
      { ...value, grids: [g45, g44, g56, g66] },
      { ...value, grid: { ...value.grid, values: ["4x4", "4x4", "5x6", "6x6"] } },
      { ...value, grid: { ...value.grid, values: ["4x4", "4x5", "5x6"] } },
      { ...value, grid: { ...value.grid, default: "5x4" } },
      { ...value, grid: { ...value.grid, default: "6x6" } },
      { ...value, faces: 17 },
    ]) {
      expect(catalogSchema.safeParse(changed).success).toBe(false);
    }
  });

  it("hands out copies: the grids it is built from are frozen", () => {
    const value = catalog();
    expect(value.grids[0]).not.toBe(GRIDS[0]);
    expect(Object.isFrozen(GRIDS)).toBe(true);
    for (const grid of GRIDS) expect(Object.isFrozen(grid)).toBe(true);
    for (const table of [GRID_IDS, PLAYERS, ERROR_CODES]) expect(Object.isFrozen(table)).toBe(true);
    expect(Object.isFrozen(FACES)).toBe(true);
    for (const face of FACES) expect(Object.isFrozen(face)).toBe(true);
  });
});
