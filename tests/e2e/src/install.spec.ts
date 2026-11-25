import { expect, test } from "./fixtures.js";
import { expectAccessible, freshAddress, signUp } from "./helpers.js";

test("Safari on iPhone offers the Add to Home Screen guide, once dismissed it stays away", async ({
  page,
}, testInfo) => {
  const onIphone = testInfo.project.name === "webkit-iphone";
  await signUp(page, freshAddress(), "Sam");
  const banner = page.getByRole("complementary", { name: "Add to Home Screen" });

  if (!onIphone) {
    // Desktop Chrome has no Home Screen to add to.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Sam");
    await expect(banner).toHaveCount(0);
    return;
  }

  await expect(banner).toBeVisible();
  await expectAccessible(page);
  await banner.getByRole("link", { name: "Show me how" }).click();
  await expect(page).toHaveURL(/\/install$/u);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add to Home Screen");
  await expect(page.getByRole("heading", { level: 2, name: /iPhone and iPad/u })).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expectAccessible(page);

  await page.getByRole("link", { name: "Home" }).click();
  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Sam");
  await expect(banner).toHaveCount(0);
});
