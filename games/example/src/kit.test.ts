import { runKit } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { engines } from "./engine/index.js";
import { manifest } from "./manifest.js";

describe("the generic test kit (02 §6)", () => {
  it("passes the example at 2, 3 and 4 players in fast mode", () => {
    // The option sets played come from the engine's own `test.optionInputs` hook.
    const report = runKit(engines, { mode: "fast", manifest });
    expect(report.failures).toEqual([]);
    expect(report.games).toBeGreaterThanOrEqual(300);
  });
});
