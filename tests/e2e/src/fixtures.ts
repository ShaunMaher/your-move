/**
 * Shared fixtures, used by every spec: each worker warms its browser before its first test, and
 * every test fails on a Content-Security-Policy violation (07 §4). `friend` is a second person's
 * page, for tests where two people play.
 */
import { test as base, expect, type Browser, type Page, type TestInfo } from "@playwright/test";

import { WARMUP_TIMEOUT_MS } from "./budgets.js";

interface Violation {
  readonly directive: string;
  readonly blocked: string;
  /** Where and what, to make a failure diagnosable: the script's file and line, and the blocked text. */
  readonly where: string;
}

/**
 * Starts recording `securitypolicyviolation` events in every frame of a page; the returned
 * function gives what was recorded. Must be called before the page navigates.
 */
async function trackCspViolations(page: Page): Promise<() => Promise<Violation[]>> {
  await page.addInitScript(() => {
    const violations: { directive: string; blocked: string; where: string }[] = [];
    Object.defineProperty(window, "__cspViolations", { value: violations });
    document.addEventListener("securitypolicyviolation", (event) => {
      if ((window as unknown as { __ignoreCsp?: boolean }).__ignoreCsp === true) return;
      violations.push({
        directive: event.violatedDirective,
        blocked: event.blockedURI,
        where: `${event.sourceFile}:${String(event.lineNumber)} ${event.sample.slice(0, 80)}`,
      });
    });
  });
  return async () => {
    const found: Violation[] = [];
    for (const frame of page.frames()) {
      const inFrame = await frame
        .evaluate(
          () => (window as unknown as { __cspViolations?: Violation[] }).__cspViolations ?? [],
        )
        .catch(() => []);
      found.push(...inFrame);
    }
    return found;
  };
}

/**
 * On a failed test, Playwright's failure screenshot inserts an inline `<style>` (to freeze
 * animations) before these fixtures collect, and the page's CSP rightly blocks and reports it.
 * That is Playwright's, not the page's, and only buries the real failure, so it is dropped, and
 * only once the test has already failed: a passing test never has a violation excused.
 */
function withoutScreenshotNoise(violations: Violation[], testInfo: TestInfo): Violation[] {
  if (testInfo.status === testInfo.expectedStatus) return violations;
  return violations.filter(
    (violation) => !(violation.directive.startsWith("style-src") && violation.blocked === "inline"),
  );
}

/** The device settings a person's context takes, as the project and the test's `use` give them. */
interface Device {
  readonly baseURL: string | undefined;
  readonly viewport: { width: number; height: number } | null | undefined;
  readonly userAgent: string | undefined;
  readonly deviceScaleFactor: number | undefined;
  readonly isMobile: boolean | undefined;
  readonly hasTouch: boolean | undefined;
}

/** A page in a context of its own with the given device settings, and its CSP check. */
async function openPlayer(
  browser: Browser,
  device: Device,
  testInfo: TestInfo,
): Promise<{ page: Page; violations: () => Promise<Violation[]>; close: () => Promise<void> }> {
  const { baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = device;
  const context = await browser.newContext({
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(viewport === undefined ? {} : { viewport }),
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
    ...(isMobile === undefined ? {} : { isMobile }),
    ...(hasTouch === undefined ? {} : { hasTouch }),
  });
  const page = await context.newPage();
  const collect = await trackCspViolations(page);
  return {
    page,
    violations: async () => withoutScreenshotNoise(await collect(), testInfo),
    close: () => context.close(),
  };
}

export const test = base.extend<
  { cspViolations: Violation[]; friend: Page; crowd: Page[] },
  { browserWarmup: undefined }
>({
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
    async ({ page }, use, testInfo) => {
      const collect = await trackCspViolations(page);
      const violations: Violation[] = [];
      await use(violations);
      violations.push(...(await collect()));
      expect(
        withoutScreenshotNoise(violations, testInfo),
        "Content-Security-Policy violations",
      ).toEqual([]);
    },
    { auto: true },
  ],
  /**
   * A second person: a page in a context of its own (separate cookies and storage) with the
   * project's device settings, for tests where two people play each other. It fails the test on a
   * Content-Security-Policy violation like the first.
   */
  friend: async (
    { browser, baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch },
    use,
    testInfo,
  ) => {
    const device = { baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
    const player = await openPlayer(browser, device, testInfo);
    await use(player.page);
    const violations = await player.violations();
    await player.close();
    expect(violations, "Content-Security-Policy violations (second player)").toEqual([]);
  },
  /**
   * Two more people, for games of four (the paths game's e2e, alpha A24): each a page in a context
   * of its own, like `friend`, with the same device settings (the test's `use` included, so a
   * phone test gets touch in every context). Every context is closed and every page's
   * Content-Security-Policy violations collected before the one expectation, so a failure in one
   * never hides another's.
   */
  crowd: async (
    { browser, baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch },
    use,
    testInfo,
  ) => {
    const device = { baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
    const players = [
      await openPlayer(browser, device, testInfo),
      await openPlayer(browser, device, testInfo),
    ];
    await use(players.map((player) => player.page));
    const found: Violation[][] = [];
    for (const player of players) {
      found.push(await player.violations().catch(() => []));
      await player.close().catch(() => undefined);
    }
    expect(found.flat(), "Content-Security-Policy violations (third and fourth players)").toEqual(
      [],
    );
  },
});

export { expect };
