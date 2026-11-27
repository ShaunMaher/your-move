/** Helpers shared by the specs: signing in through the dev email capture, and accessibility checks. */
import { AxeBuilder } from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";

import { expect } from "./fixtures.js";

let counter = 0;
/** An address no other test uses, so the per-address limits never interfere. */
export function freshAddress(): string {
  counter += 1;
  return `player-${String(Date.now())}-${String(counter)}-${String(process.pid)}@example.org`;
}

/** One email the dev capture holds (`/__dev/emails`, local dev only). */
export interface CapturedEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly listUnsubscribe?: string;
}

/** The `n`th email (0-based) sent to `address` whose subject matches, once it has arrived. */
export async function emailTo(
  request: APIRequestContext,
  address: string,
  subject: RegExp,
  n = 0,
): Promise<CapturedEmail> {
  let found: CapturedEmail | undefined;
  await expect
    .poll(async () => {
      const response = await request.get("/__dev/emails");
      const { emails } = (await response.json()) as { emails: CapturedEmail[] };
      found = emails.filter((email) => email.to === address && subject.test(email.subject))[n];
      return found !== undefined;
    })
    .toBe(true);
  if (found === undefined) throw new Error("no such email");
  return found;
}

/**
 * The code in the `n`th sign-in code email sent to `address` (0-based), read from the dev email
 * capture. The subject carries the code ungrouped (06 §3.3). Other emails to the address (an
 * invitation, alpha A17) don't count.
 */
export async function codeFrom(
  request: APIRequestContext,
  address: string,
  n: number,
): Promise<string> {
  const email = await emailTo(request, address, /^\d{8} is your /u, n);
  return /^(\d{8}) is your /u.exec(email.subject)?.[1] ?? "";
}

/**
 * Fails on any serious or critical axe violation on the page as it is now. `skip` names rules not
 * checked, for a finding that belongs to someone else's code and is recorded where it is tracked.
 */
export async function expectAccessible(page: Page, skip: readonly string[] = []): Promise<void> {
  // A colour mid-transition (a button turning from disabled to enabled) is not what people see.
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished)),
  );
  const results = await new AxeBuilder({ page }).disableRules([...skip]).analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(serious.map((violation) => `${violation.id}: ${violation.nodes[0]?.html ?? ""}`)).toEqual(
    [],
  );
}

export async function requestCodeFor(page: Page, address: string): Promise<void> {
  await page.getByLabel("Email address").fill(address);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByLabel("Sign-in code")).toBeVisible();
}

/** Signs a new person in by emailed code and gives them a display name; they land on home. */
export async function signUp(page: Page, address: string, name: string): Promise<void> {
  await page.goto("/signin");
  await requestCodeFor(page, address);
  await page.getByLabel("Sign-in code").fill(await codeFrom(page.request, address, 0));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Display name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Hi, ${name}`);
}

/** The one shape a cached word list is stored at (apps/web/src/word-lists.ts). */
const WORD_LIST_PATH = /^\/assets\/dictionaries\/[A-Za-z0-9_-]+-v\d+\.[0-9a-f]{16}\.txt$/u;

/** What the page got from the service worker: `api` must stay empty; `assets` is the positive control. */
export interface WorkerResponses {
  readonly api: string[];
  readonly assets: string[];
}

/**
 * Starts recording the responses the page gets from the service worker: any `/api/` one is a bug
 * (07 §4); the others show the worker is answering at all, so an empty `api` list means something.
 */
export function watchWorkerResponses(page: Page): WorkerResponses {
  const seen: WorkerResponses = { api: [], assets: [] };
  page.on("response", (response) => {
    if (!response.fromServiceWorker()) return;
    const url = new URL(response.url());
    (url.pathname.startsWith("/api/") ? seen.api : seen.assets).push(url.pathname);
  });
  return seen;
}

/**
 * Cache Storage holds the build's precache list in the worker's own cache and, in the word-list
 * cache `dictionaries-v1`, only entries of the served word-list shape: nothing the app fetched
 * from `/api/` or anywhere else (07 §4).
 */
export async function expectOnlyShellAndWordLists(
  page: Page,
  request: APIRequestContext,
): Promise<void> {
  const source = await (await request.get("/sw.js")).text();
  const build = JSON.parse(/^const BUILD = (.*);$/mu.exec(source)?.[1] ?? "null") as {
    precache: string[];
  };
  const stored = await page.evaluate(async () => {
    const found: Record<string, string[]> = {};
    for (const name of await caches.keys()) {
      found[name] = (await (await caches.open(name)).keys())
        .map((entry) => new URL(entry.url).pathname)
        .sort();
    }
    return found;
  });
  const shell = Object.entries(stored).filter(([name]) => name !== "dictionaries-v1");
  expect(shell.flatMap(([, paths]) => paths).sort()).toEqual([...build.precache].sort());
  // The game that was played downloaded its list, and nothing else is in that cache.
  expect((stored["dictionaries-v1"] ?? []).length).toBeGreaterThanOrEqual(1);
  for (const path of stored["dictionaries-v1"] ?? []) expect(path).toMatch(WORD_LIST_PATH);
}
