import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests (11 §4, §9 stage 4) against the **Node build output** (`apps/node/dist`), the
 * same artifact the build stage produces; `pnpm build` first when running locally.
 */
const PORT = 4173;
// Built by `pnpm build` (CI: the build:app artifact). Without it the web server fails to start.
const SERVER = new URL("../../apps/node/dist/main.js", import.meta.url);

export default defineConfig({
  testDir: "src",
  forbidOnly: Boolean(process.env["CI"]),
  // A flaky test is a bug (11 §4): no silent retries.
  retries: 0,
  reporter: process.env["CI"]
    ? [["list"], ["junit", { outputFile: "../../reports/e2e-junit.xml" }]]
    : [["list"]],
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
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
      APP_SECRET: "bG9jYWwtZGV2LW9ubHktbm90LWEtc2VjcmV0LWRvLW5vdC11c2U=", // gitleaks:allow
      EMAIL_PROVIDER: "console",
      EMAIL_FROM: "no-reply@localhost",
      OPERATOR_CONTACT: "ops@localhost",
    },
  },
});
