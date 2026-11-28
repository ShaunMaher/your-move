import { defineProject } from "vitest/config";

/**
 * The statistical timing suite (ADR 0006) is a measurement, not an ordinary test: `pnpm test` skips
 * it and `pnpm test:timing` (which sets this variable) runs only it. This project has its own
 * config, so the root config's projects() switch doesn't reach it: the switch lives here too.
 */
const TIMING = process.env["YM_TIMING"] === "1";
const TIMING_FILE = "src/auth-timing.test.ts";

export default defineProject({
  test: {
    name: "apps/node",
    include: TIMING ? [TIMING_FILE] : ["src/**/*.test.ts"],
    exclude: TIMING ? [] : ["**/node_modules/**", TIMING_FILE],
    // The game tests read the built-in dictionaries' served layout: built first if missing.
    globalSetup: ["src/test-global-setup.ts"],
  },
});
