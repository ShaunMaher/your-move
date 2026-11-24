import { runKit } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { engines } from "./engine/index.js";
import { manifest } from "./manifest.js";

describe("the generic test kit (02 §6)", () => {
  it("passes the words engine under every ruleset in fast mode, with its own hooks", () => {
    // The option inputs (one per ruleset) and the kit dictionary come from the engine's hooks.
    const report = runKit(engines, { mode: "fast", manifest });
    expect(report.failures).toEqual([]);
    expect(report.games).toBeGreaterThanOrEqual(300);
  }, 120_000);
});
