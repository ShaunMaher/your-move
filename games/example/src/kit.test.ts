import { runKit } from "@your-move/testkit";
import { threadCpuClock } from "@your-move/testkit/cpu-clock";
import { describe, expect, it } from "vitest";

import { engines } from "./engine/index.js";
import { manifest } from "./manifest.js";

// A measured budget (ADR 0004), not Vitest's 5 s default: the run plays 300+ games, 0.43–0.45 s
// alone on a 16-thread developer machine (2026-11-25) and about 2.6 s within a full
// `pnpm test` there. The shared qemu64 CI runner has run comparable CPU-bound suites about 100×
// slower than this machine (the migrate suite, MR !13 pipeline 82267), so 60 s. TODO: re-measure
// from a CI run of this test and replace the estimate with the figure (A2 review P2-9).
describe("the generic test kit (02 §6)", { timeout: 60_000 }, () => {
  it("passes the example at 2, 3 and 4 players in fast mode", () => {
    // The option sets played come from the engine's own `test.optionInputs` hook.
    // The CPU budget is timed in this thread's CPU time, not wall time (02 §6.6).
    const report = runKit(engines, { mode: "fast", manifest, cpuClock: threadCpuClock().now });
    expect(report.failures).toEqual([]);
    expect(report.games).toBeGreaterThanOrEqual(300);
  });
});
