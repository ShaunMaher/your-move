import { OK, RESERVED_ERROR_CODES } from "@your-move/sdk";
import { seededRandom } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { facing, game, OPTIONS, placedFor, STRAIGHT } from "../test-support.js";
import { pathsV1 } from "./definition.js";
import { engines } from "./index.js";
import { recordSchema } from "./schemas.js";

const SAFE = placedFor(STRAIGHT);

describe("the paths definition (02 §2)", () => {
  it("exports rules version 1 of the paths type", () => {
    expect(Object.keys(engines)).toEqual(["1"]);
    expect(engines[1]).toBe(pathsV1);
    expect(pathsV1).toMatchObject({ type: "paths", version: 1 });
  });

  it("states the creation-time answers of paths §6", () => {
    expect(pathsV1.players(OPTIONS)).toEqual({ min: 2, max: 8 });
    expect(pathsV1.validateStart(OPTIONS, 8)).toEqual(OK);
    expect(pathsV1.defaultTurnTimeoutDays(OPTIONS)).toBe(3);
    expect(pathsV1.resources(OPTIONS)).toEqual([]);
    expect(pathsV1.checkConfig(pathsV1.configSchema.parse({}), [])).toEqual(OK);
    expect("preview" in pathsV1).toBe(false);
  });

  it("declares its error codes, none of them reserved (02 §2.2)", () => {
    expect([...pathsV1.errorCodes].sort()).toEqual([
      "INVALID_OPTION",
      "NOTCH_OCCUPIED",
      "NOT_IN_HAND",
      "NOT_TO_ACT",
      "OPTIONS_NOT_OBJECT",
      "OUT_OF_RANGE",
      "SELF_ELIMINATION_AVOIDABLE",
      "UNKNOWN_OPTION",
      "WRONG_PHASE",
    ]);
    for (const code of pathsV1.errorCodes) expect(RESERVED_ERROR_CODES).not.toContain(code);
  });

  it("dispatches each action, resignation and timeout to its transition", () => {
    const markers = game({
      phase: "markers",
      markers: [facing(0, 0, 0), { pos: null, out: null }],
      turn: 1,
    });
    expect(
      pathsV1.apply(markers, 1, { type: "place-marker", edgeNotch: 5 }, seededRandom(1)).record
        .type,
    ).toBe("place-marker");
    const tiles = game({
      markers: [facing(0, 2, 0), facing(5, 5, 4)],
      hands: [[SAFE.tileId], [1]],
    });
    const played = pathsV1.apply(tiles, 0, { type: "place-tile", ...SAFE }, seededRandom(1));
    expect(played.record.type).toBe("place-tile");
    expect(recordSchema.parse(played.record)).toEqual(played.record);
    expect(pathsV1.onResign(tiles, 1, seededRandom(1), "resign").record.type).toBe("resign");
    expect(pathsV1.onResign(tiles, 1, seededRandom(1), "decline").record.type).toBe("decline");
    expect(pathsV1.onTimeout(tiles, 1, seededRandom(1)).record.type).toBe("timeout");
  });
});
