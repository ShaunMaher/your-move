import { runKit } from "@your-move/testkit";
import { threadCpuClock } from "@your-move/testkit/cpu-clock";
import { describe, expect, it } from "vitest";

import { engines } from "./engine/index.js";
import { manifest } from "./manifest.js";

// A measured budget (ADR 0004), not Vitest's 5 s default: the fast run plays its 300 games, every
// seat count from 2 to 6 on each grid, in about 7 s alone on a 16-thread developer machine
// (2026-11-29). The shared qemu64 CI runner has run comparable CPU-bound suites about 100× slower
// than this machine (the example package's kit test), so 600 s.
describe("the generic test kit (02 §6)", { timeout: 600_000 }, () => {
  it("passes the pairs engine at every seat count from 2 to 6, on every grid", () => {
    // The grids played come from the engine's own `test.optionInputs` hook, and every seat count
    // `players` allows. The CPU budget is timed in this thread's CPU time (02 §6.6).
    const report = runKit(engines, { mode: "fast", manifest, cpuClock: threadCpuClock().now });
    expect(report.failures).toEqual([]);
    expect(report.games).toBeGreaterThanOrEqual(300);
  });
});
