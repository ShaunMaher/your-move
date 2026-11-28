import { OK, RESERVED_ERROR_CODES } from "@your-move/sdk";
import { describe, expect, it } from "vitest";

import { OPTIONS } from "../test-support.js";
import { pairsV1 } from "./definition.js";
import { FACES } from "./faces.js";
import { engines } from "./index.js";
import { GRIDS } from "./schemas.js";

describe("the pairs definition (02 §2)", () => {
  it("exports rules version 1 of the pairs type", () => {
    expect(Object.keys(engines)).toEqual(["1"]);
    expect(engines[1]).toBe(pairsV1);
    expect(pairsV1).toMatchObject({ type: "pairs", version: 1 });
  });

  it("states the creation-time answers of pairs §7", () => {
    for (const { id } of GRIDS) {
      expect(pairsV1.players({ grid: id })).toEqual({ min: 2, max: 6 });
      expect(pairsV1.validateStart({ grid: id }, 6)).toEqual(OK);
    }
    expect(pairsV1.defaultTurnTimeoutDays(OPTIONS)).toBe(3);
    expect(pairsV1.resources(OPTIONS)).toEqual([]);
    expect(pairsV1.checkConfig(pairsV1.configSchema.parse({}), [])).toEqual(OK);
    expect(pairsV1.configSchema.safeParse({ x: 1 }).success).toBe(false);
    expect("preview" in pairsV1).toBe(false);
    expect("previewSchema" in pairsV1).toBe(false);
  });

  it("declares its error codes, none of them reserved (02 §2.2)", () => {
    expect([...pairsV1.errorCodes].sort()).toEqual([
      "CARD_FACE_UP",
      "INVALID_OPTION",
      "NOT_TO_ACT",
      "OPTIONS_NOT_OBJECT",
      "OUT_OF_RANGE",
      "UNKNOWN_OPTION",
    ]);
    for (const code of pairsV1.errorCodes) expect(RESERVED_ERROR_CODES).not.toContain(code);
  });

  it("accepts only strict flips of safe integers", () => {
    const schema = pairsV1.actionSchema;
    expect(schema.safeParse({ type: "flip", row: 0, column: 0 }).success).toBe(true);
    expect(schema.safeParse({ type: "flip", row: -3, column: 2 ** 40 }).success).toBe(true);
    for (const bad of [
      { type: "flip", row: 0.5, column: 0 },
      { type: "flip", row: 0, column: 2 ** 53 },
      { type: "flip", row: 0 },
      { type: "flip", row: 0, column: 0, face: 1 },
      { type: "turn", row: 0, column: 0 },
    ]) {
      expect(schema.safeParse(bad).success).toBe(false);
    }
  });

  it("names 18 distinct faces (pairs §1)", () => {
    expect(FACES).toHaveLength(18);
    expect(new Set(FACES.map((face) => face.name)).size).toBe(18);
    expect(FACES[11]).toEqual({ name: "leaf", plural: "leaves" });
  });
});
