/** The sweep's own error handling (docs/spec/03-architecture.md §8). */
import { describe, expect, it } from "vitest";

import { testPlatform } from "../test-support.js";
import { createSweep } from "./sweep.js";

describe("sweep", () => {
  it("logs a failing step by class, reports it as null and never rejects", async () => {
    // No database: the nudge step's first read fails.
    const platform = testPlatform();
    const report = await createSweep({ platform, games: [], nudgesPerRun: 10 })();
    expect(report).toEqual({ nudges: null });
    expect(platform.lines).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "sweep step failed",
        step: "nudges",
        errorClass: "DetachedStorageError",
      }),
    );
    expect(JSON.stringify(platform.lines)).not.toContain("no database");
    expect(platform.lines.at(-1)).toMatchObject({ msg: "sweep finished", nudgesFailedStep: true });
  });

  it("reports what the nudge step did", async () => {
    const platform = testPlatform();
    const repos = {
      ...platform.repos,
      rateLimits: {
        hit: (hits: readonly unknown[]) =>
          Promise.resolve(hits.map(() => ({ current: 0, previous: 0 }))),
      },
      nudges: { due: () => Promise.resolve([]), claim: () => Promise.resolve(false) },
    };
    const report = await createSweep({
      platform: { ...platform, repos },
      games: [],
      nudgesPerRun: 10,
    })();
    expect(report).toEqual({ nudges: { due: 0, sent: 0, failed: 0, skipped: 0, capped: false } });
    expect(platform.lines.at(-1)).toMatchObject({ msg: "sweep finished", nudgesSent: 0 });
  });
});
