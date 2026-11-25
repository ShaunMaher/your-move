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

/**
 * The code in the `n`th email sent to `address` (0-based), read from the dev email capture
 * (`/__dev/emails`, local dev only). The subject carries the code ungrouped (06 §3.3).
 */
export async function codeFrom(
  request: APIRequestContext,
  address: string,
  n: number,
): Promise<string> {
  let code = "";
  await expect
    .poll(async () => {
      const response = await request.get("/__dev/emails");
      const { emails } = (await response.json()) as {
        emails: { to: string; subject: string }[];
      };
      const subject = emails.filter((email) => email.to === address)[n]?.subject ?? "";
      code = /^(\d{8}) is your /u.exec(subject)?.[1] ?? "";
      return code;
    })
    .not.toBe("");
  return code;
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
