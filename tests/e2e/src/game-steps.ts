/**
 * Steps the two-person game specs share: a page's refresh on focus, whose turn the board says it
 * is, and a game created by address and accepted.
 */
import type { Page } from "@playwright/test";

import { expect } from "./fixtures.js";

/**
 * With `SHOTS_DIR` set, saves a full-page screenshot of the page as `name.png` there; otherwise
 * nothing. Playwright inserts an inline <style> to take a screenshot, which the page's CSP rightly
 * refuses and reports; those reports are not the page's, so they aren't counted.
 */
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["SHOTS_DIR"];
  if (dir === undefined) return;
  const ignore = (on: boolean) =>
    page.evaluate((value) => {
      (window as unknown as { __ignoreCsp?: boolean }).__ignoreCsp = value;
      return new Promise((done) => setTimeout(done, 0));
    }, on);
  await ignore(true);
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
  await ignore(false);
}

/** `shot` in the light theme and again in the dark one (the page follows the device's setting). */
export async function shotBothThemes(page: Page, name: string): Promise<void> {
  if (process.env["SHOTS_DIR"] === undefined) return;
  await page.emulateMedia({ colorScheme: "light" });
  await shot(page, `${name}-light`);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** Long enough for a page's poll or refetch to bring another person's move. */
export const FAR = { timeout: 20_000 };

/** The page's own refresh on regaining focus (the alpha has no realtime): what a person's return to the tab does. */
export async function refocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
  });
}

/**
 * The words board draws the scores and whose turn it is (the shell adds neither while a board is
 * on screen, 02 §3), so a page's turn is read off the board's score bar: the entry marked as to
 * act is the viewer's when it says "(you)".
 */
const toAct = (page: Page) => page.locator('.ym-w-scores li[aria-current="true"]');
export async function isMyTurn(page: Page): Promise<boolean> {
  return (await toAct(page).allTextContents()).some((text) => text.includes("(you)"));
}

/** Ann creates a words game and invites Bob by address; both are on the game's screen after. */
export async function createAndAccept(ann: Page, bob: Page, bobAddress: string): Promise<string> {
  await ann.getByRole("link", { name: "New game" }).click();
  await expect(ann.getByRole("heading", { level: 1 })).toHaveText("New game");
  await ann.getByRole("button", { name: /^Words/u }).click();
  await expect(ann.getByRole("heading", { name: /options/u })).toBeVisible();
  await ann.getByRole("button", { name: "Next" }).click();
  await ann.getByLabel("Their email address").fill(bobAddress);
  await expect(ann.getByText(/We'll email them an invitation from you/u)).toBeVisible();
  await ann.getByRole("button", { name: "Review" }).click();
  await expect(ann.getByText(`Check the address: ${bobAddress}`)).toBeVisible();
  await ann.getByRole("button", { name: "Create game" }).click();
  await expect(ann.getByRole("heading", { level: 1 })).toHaveText("Words lobby");
  const gameId = /\/g\/([^/]+)$/u.exec(new URL(ann.url()).pathname)?.[1] ?? "";
  expect(gameId).not.toBe("");

  // Bob finds the invitation in his list and opens it.
  await bob.goto("/");
  const invitations = bob.getByRole("region", { name: /Invitations/u });
  await expect(invitations).toBeVisible();
  await invitations.getByRole("link", { name: /Words with Ann/u }).click();
  await expect(bob.getByRole("heading", { level: 1 })).toHaveText("Words lobby");
  await bob.getByRole("button", { name: "Accept" }).click();
  return gameId;
}
