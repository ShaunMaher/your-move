/** The Node sweep timer (docs/spec/03-architecture.md §8). */
import type { SweepReport } from "@your-move/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startSweeper, SWEEP_INTERVAL_MS } from "./sweeper.js";

const REPORT: SweepReport = {
  nudges: { due: 0, sent: 0, failed: 0, skipped: 0, capped: false },
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startSweeper", () => {
  it("runs every 15 minutes, the first run one period after start", async () => {
    expect(SWEEP_INTERVAL_MS).toBe(15 * 60 * 1000);
    const sweep = vi.fn(() => Promise.resolve(REPORT));
    const sweeper = startSweeper(sweep);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS - 1);
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(3);
    await sweeper.stop();
  });

  it("skips a run while the previous one is still going, and stop waits for it", async () => {
    let finish: () => void = () => undefined;
    const sweep = vi.fn(
      () =>
        new Promise<SweepReport>((resolve) => {
          finish = () => {
            resolve(REPORT);
          };
        }),
    );
    const sweeper = startSweeper(sweep, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sweep).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = sweeper.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("survives a run that rejects and keeps running", async () => {
    const sweep = vi
      .fn<() => Promise<SweepReport>>()
      .mockRejectedValueOnce(new Error("bug"))
      .mockResolvedValue(REPORT);
    const sweeper = startSweeper(sweep, 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sweep).toHaveBeenCalledTimes(2);
    await sweeper.stop();
  });
});
