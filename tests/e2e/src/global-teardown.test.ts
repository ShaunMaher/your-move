import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import globalTeardown from "./global-teardown.js";

let keep: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (keep !== undefined) rmSync(keep, { recursive: true, force: true });
  keep = undefined;
});

describe("e2e global teardown (M2a review P2-7)", () => {
  it("removes the run's own directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "your-move-e2e-"));
    vi.stubEnv("E2E_DATA_DIR", dir);
    globalTeardown();
    expect(existsSync(dir)).toBe(false);
  });

  it.each([
    ["another directory", (other: string) => other],
    [
      "a path that climbs out of the prefix",
      (other: string) => join(tmpdir(), "your-move-e2e-x") + `/../${basename(other)}`,
    ],
  ])("leaves %s alone", (_name, target) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    keep = mkdtempSync(join(tmpdir(), "teardown-keep-"));
    vi.stubEnv("E2E_DATA_DIR", target(keep));
    globalTeardown();
    expect(existsSync(keep)).toBe(true);
  });
});
