/**
 * The e2e suite's time budgets, in one place. Each is a deliberate limit sized from measured CI
 * runs (issue #7), never a retry (11 §4); playwright.config.ts explains how they fit together.
 */

/**
 * Each test, including its test-scoped fixtures (`context`, `page`, `cspViolations`): Playwright's
 * default, kept. Once a worker's browser is warm, the slowest test seen on a loaded CI runner took
 * 8.3 s, so this leaves more than 3× headroom for the tests themselves.
 */
export const TEST_TIMEOUT_MS = 30_000;

/**
 * One browser launch (`browserType.launch`). Playwright's `browser` fixture has no fixture
 * timeout of its own, so this is the only limit on a launch. The slowest launch seen to succeed on
 * CI took 67 s (Chromium, 3 pipelines on the runner); 120 s is about twice that. A launch that
 * outlives it has hung rather than slowed (the one seen did not finish in 180 s, while the three
 * launches after it in the same job took 1–15 s), and failing it a minute sooner than Playwright's
 * 180 s default changes nothing else.
 */
export const LAUNCH_TIMEOUT_MS = 120_000;

/**
 * The per-worker warm-up (`browserWarmup` in fixtures.ts): the first context, page and page load
 * of a freshly launched browser. That first page is the one-off cost the first test of each shard
 * used to pay inside its 30 s: a passing first test took up to 23 s on a loaded runner against
 * 1–8 s for the tests after it, and two failed with the first page still opening after 28–30 s.
 * 90 s is three times the budget those failures ran out of. Reproduced locally (the pinned image,
 * half a CPU, a 30 s CPU spike from the first content process on), WebKit's warm-up took 37–39 s
 * and the first test then 3–4 s, where without it the first test failed at 35–38 s.
 */
export const WARMUP_TIMEOUT_MS = 90_000;
