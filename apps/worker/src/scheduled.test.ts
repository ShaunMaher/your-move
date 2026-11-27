/** The Worker's Cron Trigger outcome (03 §8, 09 §3; alpha A6 review P2-6). */
import type { SweepReport } from "@your-move/server";
import { describe, expect, it, vi } from "vitest";

import { runScheduled } from "./scheduled.js";

const clean: SweepReport = {
  lobbies: 1,
  claims: { claimed: 1, skipped: 0 },
  nudges: { due: 1, sent: 1, failed: 0, skipped: 0, capped: false },
};

function controller() {
  return { noRetry: vi.fn() };
}

describe("runScheduled", () => {
  it("ends cleanly when the sweep ran every step and no nudge failed", async () => {
    const control = controller();
    await expect(runScheduled(control, () => Promise.resolve(clean))).resolves.toBeUndefined();
    expect(control.noRetry).not.toHaveBeenCalled();
  });

  it("ends cleanly, without touching retries, when the daily cap stopped the run", async () => {
    const capped: SweepReport = {
      ...clean,
      nudges: { sent: 0, failed: 0, skipped: 0, capped: true },
    };
    const control = controller();
    await expect(runScheduled(control, () => Promise.resolve(capped))).resolves.toBeUndefined();
    expect(control.noRetry).not.toHaveBeenCalled();
  });

  it.each<[string, SweepReport | null]>([
    ["a failed nudge step", { ...clean, nudges: null }],
    ["a failed claim step", { ...clean, claims: null }],
    ["a failed lobby step", { ...clean, lobbies: null }],
    [
      "a failed nudge",
      { ...clean, nudges: { due: 2, sent: 1, failed: 1, skipped: 0, capped: false } },
    ],
    ["a Worker that couldn't be built", null],
  ])("fails the invocation, without a retry, after %s", async (_name, report) => {
    const control = controller();
    const sweep = report === null ? null : () => Promise.resolve(report);
    await expect(runScheduled(control, sweep)).rejects.toThrow("did not complete cleanly");
    expect(control.noRetry).toHaveBeenCalledOnce();
  });
});
