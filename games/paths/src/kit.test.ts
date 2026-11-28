import { runKit } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { engines } from "./engine/index.js";
import { manifest } from "./manifest.js";

// A measured budget (ADR 0004), not Vitest's 5 s default: the fast run plays its 300+ games, every
// seat count from 2 to 8 under each option input, in about 3 s alone on a 16-thread developer
// machine (2026-11-28). The shared qemu64 CI runner has run comparable CPU-bound suites about
// 100× slower than this machine (the example package's kit test), so 300 s.
describe("the generic test kit (02 §6)", { timeout: 300_000 }, () => {
  it("passes the paths engine at every seat count from 2 to 8, under each option input", () => {
    // The option sets played come from the engine's own `test.optionInputs` hook, and every seat
    // count `players` allows (2 to 8, so 2, 3, 5 and 8 among them, 10 §M5).
    const report = runKit(engines, { mode: "fast", manifest });
    expect(report.failures).toEqual([]);
    expect(report.games).toBeGreaterThanOrEqual(300);
  });
});
