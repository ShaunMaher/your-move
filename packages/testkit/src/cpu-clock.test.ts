import { describe, expect, it } from "vitest";

import { threadCpuClock } from "./cpu-clock.js";

/** Milliseconds of wall time spent spinning until `clock` has moved `ms` forward. */
function burn(clock: () => number, ms: number): number {
  const wallStart = performance.now();
  const start = clock();
  while (clock() - start < ms) {
    // Busy: CPU time passes only while this thread runs.
  }
  return performance.now() - wallStart;
}

describe("threadCpuClock (02 §6.6)", () => {
  it("uses this thread's CPU time on Node", () => {
    expect(threadCpuClock().source).toBe("thread CPU time");
  });

  it("advances with busy work: CPU time never runs ahead of wall time", () => {
    // If the clock didn't count this thread's work, `burn` would never return (the test's timeout).
    // One thread can't use more CPU than wall time, give or take the clock's steps of about 1 ms.
    expect(burn(threadCpuClock().now, 20)).toBeGreaterThanOrEqual(18);
  });

  it("doesn't advance while the thread waits", () => {
    const clock = threadCpuClock().now;
    const start = clock();
    // Blocks this thread for 60 ms without running it (ECMAScript, so no host types needed).
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
    // Waking up costs a little CPU, and the clock steps by about 1 ms; 60 ms of waiting costs none.
    expect(clock() - start).toBeLessThan(15);
  });

  it("falls back to the process's CPU time, then to the wall clock", () => {
    const usage = { user: 1500, system: 500 };
    const process = { cpuUsage: () => usage };
    const fallback = threadCpuClock({ process });
    expect(fallback.source).toBe("process CPU time");
    expect(fallback.now()).toBe(2);
    const wall = threadCpuClock({ process: {}, performance: { now: () => 42 } });
    expect(wall).toMatchObject({ source: "wall clock" });
    expect(wall.now()).toBe(42);
  });

  it("calls the host's functions on the host's process object", () => {
    const process = {
      calls: 0,
      threadCpuUsage(this: { calls: number }) {
        this.calls += 1;
        return { user: 3000, system: 1000 };
      },
    };
    expect(threadCpuClock({ process }).now()).toBe(4);
    expect(process.calls).toBe(1);
  });
});
