import { expect, test } from "./fixtures.js";
import { expectAccessible, freshAddress, signUp } from "./helpers.js";

test("choosing Dark in Settings sets the theme, survives a reload, and passes axe", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one browser is enough for the colours");
  const root = page.locator("html");
  await signUp(page, freshAddress(), "Sam");
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  await expect(page.getByRole("radio", { name: "System" })).toBeChecked();
  await expect(root).not.toHaveAttribute("data-theme", /.*/u);

  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(21, 21, 21)");
  await expectAccessible(page);

  // The choice is the server's: it is there again after a reload.
  await page.reload();
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect(root).toHaveAttribute("data-theme", "dark");

  await page.getByRole("radio", { name: "Light" }).click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await expectAccessible(page);
});
