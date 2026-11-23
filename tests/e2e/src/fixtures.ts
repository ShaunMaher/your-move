/**
 * Shared fixtures: every test fails on a Content-Security-Policy violation (07 §4).
 */
import { test as base, expect } from "@playwright/test";

interface Violation {
  readonly directive: string;
  readonly blocked: string;
}

export const test = base.extend<{ cspViolations: Violation[] }>({
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
