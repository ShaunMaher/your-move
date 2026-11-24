/**
 * Shared fixtures, used by every spec: each worker warms its browser before its first test, and
 * every test fails on a Content-Security-Policy violation (07 §4).
 */
import { test as base, expect } from "@playwright/test";

import { WARMUP_TIMEOUT_MS } from "./budgets.js";

interface Violation {
  readonly directive: string;
  readonly blocked: string;
}

export const test = base.extend<{ cspViolations: Violation[] }, { browserWarmup: undefined }>({
  /**
   * Opens and loads the shell once, in a throwaway context, as soon as the worker's browser has
   * launched and under a budget of its own. The cold first page of a fresh browser (its first
   * content process, on a slow or loaded runner) is then not charged to whichever test happens to
   * run first (issue #7). Every test still gets its own fresh context and page.
   */
  browserWarmup: [
    async ({ browser }, use, workerInfo) => {
      const { baseURL } = workerInfo.project.use;
      if (baseURL === undefined) throw new Error("The warm-up needs use.baseURL (the config).");
      const context = await browser.newContext({ baseURL });
      try {
        const page = await context.newPage();
        // No navigation limit of its own: the fixture's budget bounds the whole warm-up.
        await page.goto("/", { timeout: 0 });
      } finally {
        await context.close();
      }
      await use(undefined);
    },
    { scope: "worker", auto: true, timeout: WARMUP_TIMEOUT_MS, title: "warm up the browser" },
  ],
  cspViolations: [
    async ({ page }, use) => {
      await page.addInitScript(() => {
        const violations: { directive: string; blocked: string }[] = [];
        Object.defineProperty(window, "__cspViolations", { value: violations });
        document.addEventListener("securitypolicyviolation", (event) => {
          violations.push({ directive: event.violatedDirective, blocked: event.blockedURI });
        });
      });
      const violations: Violation[] = [];
      await use(violations);
      for (const frame of page.frames()) {
        const found = await frame
          .evaluate(
            () => (window as unknown as { __cspViolations?: Violation[] }).__cspViolations ?? [],
          )
          .catch(() => []);
        violations.push(...found);
      }
      expect(violations, "Content-Security-Policy violations").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
