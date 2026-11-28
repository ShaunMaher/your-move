import { expect, test } from "./fixtures.js";
import { codeFrom, expectAccessible, freshAddress, requestCodeFor } from "./helpers.js";

test("someone under the minimum age leaves at onboarding: the new account goes, with the parent or carer message", async ({
  page,
  request,
}) => {
  const address = freshAddress();
  await page.goto("/signin");
  await requestCodeFor(page, address);
  await page.getByLabel("Sign-in code").fill(await codeFrom(request, address, 0));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome to E2E Games");
  await expect(page.getByText("E2E Games is for people aged 13 or older.")).toBeVisible();

  // Continue without confirming the age is refused on the page.
  await page.getByLabel("Display name").fill("Kim");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Confirm you're 13 or older to continue." }),
  ).toBeVisible();

  await page.getByRole("button", { name: "I'm under 13" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're signed out");
  await expect(
    page.getByText("Ask a parent or carer to sign in and play with you on their account."),
  ).toBeVisible();
  await expectAccessible(page);

  // The session is gone: a reload is the sign-in screen.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");

  // Signing in with the address again starts a new account from scratch.
  await requestCodeFor(page, address);
  await page.getByLabel("Sign-in code").fill(await codeFrom(request, address, 1));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome to E2E Games");
  await page.getByLabel("Display name").fill("Kim");
  await page.getByLabel("I'm 13 or older").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Kim");
});

test("the privacy page is readable before signing in", async ({ page }) => {
  await page.goto("/signin");
  await page.getByRole("link", { name: "Privacy" }).click();
  await expect(page).toHaveURL(/\/privacy$/u);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy");
  await expect(
    page.getByText(
      "Children under 13 can play only through a parent's or carer's account, with the parent or carer signed in.",
      { exact: false },
    ),
  ).toBeVisible();
  await expectAccessible(page);
  // Reloading it signed out stays on it.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy");
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
});
