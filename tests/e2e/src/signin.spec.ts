import { expect, test } from "./fixtures.js";
import { codeFrom, expectAccessible, freshAddress, requestCodeFor } from "./helpers.js";

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
  await page.getByLabel("I'm 13 or older").check();
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
  await page.getByLabel("I'm 13 or older").check();
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

test("with the service worker in charge, no API response comes from it and only the shell is cached", async ({
  page,
  request,
}) => {
  const address = freshAddress();
  const fromWorker: string[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/") && response.fromServiceWorker()) {
      fromWorker.push(response.url());
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  // Wait until the worker controls the page, so the calls below really pass through it.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  await requestCodeFor(page, address);
  await page.getByLabel("Sign-in code").fill(await codeFrom(request, address, 0));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Display name").fill("Robin");
  await page.getByLabel("I'm 13 or older").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/signin$/u);

  expect(fromWorker).toEqual([]);

  // Cache Storage holds the shell and the build's files, and nothing the app fetched since.
  const source = await (await request.get("/sw.js")).text();
  const build = JSON.parse(/^const BUILD = (.*);$/mu.exec(source)?.[1] ?? "null") as {
    precache: string[];
  };
  const cached = await page.evaluate(async () => {
    const paths: string[] = [];
    for (const name of await caches.keys()) {
      for (const entry of await (await caches.open(name)).keys()) {
        paths.push(new URL(entry.url).pathname);
      }
    }
    return paths.sort();
  });
  expect(cached).toEqual([...build.precache].sort());
});
