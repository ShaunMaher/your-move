import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { LAUNCH_TIMEOUT_MS, TEST_TIMEOUT_MS } from "./src/budgets.js";

/**
 * End-to-end tests (11 §4, §9 stage 4) against the **Node build output** (`apps/node/dist`), the
 * same artifact the build stage produces; `pnpm build` first when running locally.
 *
 * Time budgets (src/budgets.ts has the numbers and the measurements behind them). A slow machine
 * must not fail a test whose code is fine, and a flaky test is a bug that is never retried
 * silently (11 §4), so the browser's one-off start-up costs each have their own budget, separate
 * from the tests':
 *
 * - **Launch** (`launchOptions.timeout`, 120 s). Playwright's `browser` fixture has no fixture
 *   timeout, so a launch is never charged to a test; this limit is the only one on it.
 * - **Warm-up** (`browserWarmup` in src/fixtures.ts, 90 s). A fresh browser's first page is far
 *   slower than every later one: on the shared amd64 runner (a `qemu64` VM, often running two or
 *   three pipelines) it took up to 23 s in passing jobs and over 28 s in failing ones, against 1–8 s
 *   for the tests that followed. Without the warm-up, that cost fell inside the 30 s of whichever
 *   test ran first in each worker (issue #7). The warm-up pays it once per worker, before any test.
 * - **Test** (`timeout`, 30 s): each test and its test-scoped fixtures, against a warm browser.
 *
 * On CI the shard is the unit of parallelism (the e2e job's `parallel`): each job runs one worker,
 * so a runner already busy with other pipelines gets one browser per e2e job and no more.
 * Playwright's git commit capture is off: nothing here reports it, and on a loaded runner its
 * `git log` timed out (3 s) before the tests even started.
 */
const PORT = 4173;
// Built by `pnpm build` (CI: the build:app artifact). Without it the web server fails to start.
const SERVER = new URL("../../apps/node/dist/main.js", import.meta.url);
// A fresh database per run, created and migrated by the server at startup. Only the name is chosen
// here, once: Playwright loads this file again in each worker, which inherit the variable, and
// src/global-teardown.ts removes the directory.
process.env["E2E_DATA_DIR"] ??= join(tmpdir(), `your-move-e2e-${randomUUID()}`);
const DATABASE_PATH = join(process.env["E2E_DATA_DIR"], "app.sqlite");

export default defineConfig({
  testDir: "src",
  globalTeardown: "./src/global-teardown.ts",
  forbidOnly: Boolean(process.env["CI"]),
  // A flaky test is a bug (11 §4): no silent retries.
  retries: 0,
  timeout: TEST_TIMEOUT_MS,
  ...(process.env["CI"] ? { workers: 1 } : {}),
  captureGitInfo: { commit: false, diff: false },
  reporter: process.env["CI"]
    ? [["list"], ["junit", { outputFile: "../../reports/e2e-junit.xml" }]]
    : [["list"]],
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    launchOptions: { timeout: LAUNCH_TIMEOUT_MS },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "webkit-iphone", use: { ...devices["iPhone 15"] } },
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `node --disallow-code-generation-from-strings ${SERVER.pathname}`,
    url: `http://localhost:${String(PORT)}/api/health`,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      PUBLIC_URL: `http://localhost:${String(PORT)}`,
      APP_NAME: "E2E Games",
      // The published local-dev secret, accepted only with an http://localhost PUBLIC_URL.
      APP_SECRET: "bG9jYWwtZGV2LW9ubHktbm90LWEtc2VjcmV0LWRvLW5vdC11c2U=",
      EMAIL_PROVIDER: "console",
      EMAIL_FROM: "no-reply@localhost",
      OPERATOR_CONTACT: "ops@localhost",
      DATABASE_PATH,
    },
  },
});
