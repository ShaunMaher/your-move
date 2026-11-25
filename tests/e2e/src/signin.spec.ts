import { AxeBuilder } from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";

import { expect, test } from "./fixtures.js";

let counter = 0;
/** An address no other test uses, so the per-address limits never interfere. */
function freshAddress(): string {
  counter += 1;
  return `player-${String(Date.now())}-${String(counter)}-${String(process.pid)}@example.org`;
}

/**
 * The code in the `n`th email sent to `address` (0-based), read from the dev email capture
 * (`/__dev/emails`, local dev only). The subject carries the code ungrouped (06 §3.3).
 */
async function codeFrom(request: APIRequestContext, address: string, n: number): Promise<string> {
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

async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(serious.map((violation) => `${violation.id}: ${violation.nodes[0]?.html ?? ""}`)).toEqual(
    [],
  );
}

async function requestCodeFor(page: Page, address: string): Promise<void> {
  await page.getByLabel("Email address").fill(address);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByLabel("Sign-in code")).toBeVisible();
}

test("a new person signs in with an emailed code, names themselves, and signs out and in again", async ({
  page,
  request,
}) => {
  const address = freshAddress();

  await page.goto("/");
  await expect(page).toHaveURL(/\/signin$/u);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  await expectAccessible(page);

  await requestCodeFor(page, address);
  await expectAccessible(page);
  // A typo burns an attempt and says so without saying why it failed.
  await page.getByLabel("Sign-in code").fill("00000000");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("That code didn't work");

  // The real code, pasted the way the email shows it: two groups of four.
  const code = await codeFrom(request, address, 0);
  await page.getByLabel("Sign-in code").fill(`${code.slice(0, 4)} ${code.slice(4)}`);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/welcome$/u);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome to E2E Games");
  await expectAccessible(page);
  // A reload before finishing onboarding stays on the welcome screen (the session is a cookie).
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome to E2E Games");
  await page.getByLabel("Display name").fill("Sam");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Sam");
  await expect(page.getByRole("region", { name: "Your games" })).toBeVisible();
  await expectAccessible(page);

  // The session survives a reload.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Sam");

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  await expectAccessible(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/signin$/u);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");

  // Signing in again as the same person goes straight home: no onboarding twice.
  await requestCodeFor(page, address);
  await page.getByLabel("Sign-in code").fill(await codeFrom(request, address, 1));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Sam");
});

test("signing out everywhere ends the session", async ({ page, request }) => {
  const address = freshAddress();
  await page.goto("/signin");
  await requestCodeFor(page, address);
  await page.getByLabel("Sign-in code").fill(await codeFrom(request, address, 0));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Display name").fill("Alex");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Alex");

  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out everywhere…" }).click();
  await expect(page.getByRole("checkbox", { name: "Also revoke all my API tokens" })).toBeChecked();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Sign out everywhere", exact: true }).click();
  await expect(page).toHaveURL(/\/signin$/u);
  // The cookie is gone: a reload does not bring the person back.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
});

test.describe("a rate-limited request", () => {
  // `page.route` can't intercept what a service worker handles, so keep the worker out.
  test.use({ serviceWorkers: "block" });

  test("says so and keeps the person on the email step", async ({ page }) => {
    await page.route("**/api/v1/auth/otp/request", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "RATE_LIMITED", message: "Too many requests." } }),
      }),
    );
    await page.goto("/signin");
    await page.getByLabel("Email address").fill(freshAddress());
    await page.getByRole("button", { name: "Email me a code" }).click();
    await expect(page.getByRole("alert")).toContainText("Too many attempts");
    await expectAccessible(page);
    await expect(page.getByLabel("Sign-in code")).toHaveCount(0);
  });
});

test("the manifest and icons carry the runtime name", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  const response = await request.get("/manifest.webmanifest");
  expect(response.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = (await response.json()) as {
    name: string;
    short_name: string;
    icons: { src: string }[];
  };
  expect(manifest.name).toBe("E2E Games");
  expect(manifest.short_name).toBe("E2E Games");
  for (const { src } of manifest.icons) {
    const icon = await request.get(src);
    expect(icon.status(), src).toBe(200);
    expect(icon.headers()["content-type"], src).toBe("image/png");
  }
  const touchIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  expect((await request.get(touchIcon ?? "/missing")).status()).toBe(200);
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute(
    "content",
    "E2E Games",
  );
});

test("the service worker serves the shell offline, which then says so", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "WebKit's offline emulation does not reach service workers",
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're offline");
  await context.setOffline(false);
  // Back online, the screen recovers by itself.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
});
