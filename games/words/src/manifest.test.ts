import { isGameType } from "@your-move/sdk";
import { describe, expect, it } from "vitest";

import { client } from "./client/index.js";
import { engines } from "./engine/index.js";
import { manifest } from "./manifest.js";

describe("words package (placeholder until M1)", () => {
  it("declares a valid manifest that is BSD-2-Clause licensed", () => {
    expect(isGameType(manifest.type)).toBe(true);
    expect(manifest.licence).toBe("BSD-2-Clause");
    expect(manifest.players.min).toBeLessThanOrEqual(manifest.players.max);
  });

  it("exports no rules version and no client yet", () => {
    expect(Object.keys(engines)).toEqual([]);
    expect(client).toBeNull();
  });
});
