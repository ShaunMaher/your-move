import { AxeBuilder } from "@axe-core/playwright";
import { securityHeaders } from "@your-move/server";

import { expect, test } from "./fixtures.js";

/** The e2e server runs on plain http://localhost, so no HSTS. */
const EXPECTED_HEADERS = securityHeaders({ hsts: false, turnstile: false });

test("the shell loads and names the instance from config", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  await expect(page.locator(".brand")).toHaveText("E2E Games");
  await expect(page).toHaveTitle("E2E Games");
});

test("the shell has no serious or critical accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(serious.map((violation) => violation.id)).toEqual([]);
});

test("every response carries the shared security headers", async ({ page, request }) => {
  const assets: string[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/assets/")) assets.push(response.url());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  expect(assets.length).toBeGreaterThan(0);

  for (const url of ["/", "/g/123", "/api/health", "/api/v1/config", "/api/nope", ...assets]) {
    const response = await request.get(url);
    for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
      expect(response.headers()[name.toLowerCase()], `${name} on ${url}`).toBe(value);
    }
    expect(response.headers()["strict-transport-security"]).toBeUndefined();
  }
});

test("hashed assets are cached forever and the shell is revalidated", async ({ request, page }) => {
  let asset = "";
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/assets/") && path.endsWith(".js")) asset = path;
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  expect((await request.get(asset)).headers()["cache-control"]).toBe(
    "public, max-age=31536000, immutable",
  );
  expect((await request.get("/")).headers()["cache-control"]).toBe("no-cache");
  expect((await request.get("/api/health")).headers()["cache-control"]).toBe("no-store");
});
