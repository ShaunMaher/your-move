/** The Worker passes its own budgets to the core (09 §3; alpha A17 review R2-7). */
import type { Platform } from "@your-move/server";
import { describe, expect, it, vi } from "vitest";

const { createApp, createSweep } = vi.hoisted(() => ({
  createApp: vi.fn(() => ({})),
  createSweep: vi.fn(() => () => Promise.resolve(null)),
}));
vi.mock("@your-move/server", () => ({ createApp, createSweep }));

const { workerRuntime } = await import("./runtime.js");

describe("workerRuntime", () => {
  it("claims at most 8 seats at onboarding, and runs 1 lobby, 1 claim and 2 nudges a sweep", () => {
    const platform = {} as Platform;
    workerRuntime(platform, []);
    expect(createApp).toHaveBeenCalledWith({ platform, games: [], onboardingClaims: 8 });
    expect(createSweep).toHaveBeenCalledWith({
      platform,
      games: [],
      nudgesPerRun: 2,
      claimsPerRun: 1,
      lobbiesPerRun: 1,
    });
  });
});
