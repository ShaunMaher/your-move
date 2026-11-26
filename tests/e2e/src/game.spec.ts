/**
 * The game shell on phones (alpha slice A4, 07 §7): two people each sign in by emailed code, one
 * creates a words game and invites the other, who accepts, and they play real tile moves until
 * one resigns; plus a resignation straight after the start. Every screen is checked for serious
 * accessibility violations, and the fixtures fail any test on a Content-Security-Policy violation.
 * With `SHOTS_DIR` set, screenshots of the main screens are written there.
 */
import type { Page } from "@playwright/test";

import { GAME_LOOP_BUDGET_MS, GAME_TEST_TIMEOUT_MS, RESIGN_TEST_TIMEOUT_MS } from "./budgets.js";
import { expect, test } from "./fixtures.js";
import {
  expectAccessible,
  expectOnlyShellAndWordLists,
  freshAddress,
  signUp,
  watchWorkerResponses,
} from "./helpers.js";
import { loadWordList, takeTurn } from "./words-player.js";

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["SHOTS_DIR"];
  if (dir === undefined) return;
  // Playwright inserts an inline <style> to take a screenshot, which the page's CSP rightly
  // refuses and reports; those reports are not the page's, so they aren't counted.
  const ignore = (on: boolean) =>
    page.evaluate((value) => {
      (window as unknown as { __ignoreCsp?: boolean }).__ignoreCsp = value;
      return new Promise((done) => setTimeout(done, 0));
    }, on);
  await ignore(true);
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
  await ignore(false);
}

/** The page's own refresh on regaining focus (the alpha has no realtime): what a person's return to the tab does. */
async function refocus(page: Page): Promise<void> {
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
async function isMyTurn(page: Page): Promise<boolean> {
  return (await toAct(page).allTextContents()).some((text) => text.includes("(you)"));
}

/** The viewer's and the opponent's scores, as the board's score bar shows them. */
async function scoresOf(page: Page): Promise<number[]> {
  const entries = await page
    .getByRole("list", { name: "Scores" })
    .getByRole("listitem")
    .allTextContents();
  return entries.map((entry) => Number(/(\d+)$/u.exec(entry.trim())?.[1] ?? Number.NaN));
}

const FAR = { timeout: 20_000 };

/** Ann creates a words game and invites Bob by address; both are on the game's screen after. */
async function createAndAccept(ann: Page, bob: Page, bobAddress: string): Promise<string> {
  await ann.getByRole("link", { name: "New game" }).click();
  await expect(ann.getByRole("heading", { level: 1 })).toHaveText("New game");
  await ann.getByRole("button", { name: /^Words/u }).click();
  await expect(ann.getByRole("heading", { name: /options/u })).toBeVisible();
  await ann.getByRole("button", { name: "Next" }).click();
  await ann.getByLabel("Their email address").fill(bobAddress);
  await expect(ann.getByText(/must have signed in to E2E Games at least once/u)).toBeVisible();
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

test("two people play a words game on phones and one resigns", async ({
  page: ann,
  friend: bob,
  request,
}) => {
  test.setTimeout(GAME_TEST_TIMEOUT_MS);
  const annAddress = freshAddress();
  const bobAddress = freshAddress();
  const fromWorker = [ann, bob].map(watchWorkerResponses);
  await signUp(ann, annAddress, "Ann");
  await signUp(bob, bobAddress, "Bob");
  // The worker must be in charge for the checks of what it did and cached to mean anything.
  for (const page of [ann, bob]) {
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  }

  // Home before any game, then the new-game flow with its screens checked one by one.
  await expect(ann.getByText("No games yet")).toBeVisible();
  await expectAccessible(ann);
  await ann.getByRole("link", { name: "New game" }).click();
  await expect(ann.getByRole("button", { name: /^Words/u })).toBeVisible();
  await expectAccessible(ann);
  await shot(ann, "new-game-1-pick");
  await ann.getByRole("button", { name: /^Words/u }).click();
  await expect(ann.getByRole("heading", { name: /options/u })).toBeVisible();
  // Next is enabled once the options module has loaded; checked before then, axe can sample the
  // button at the start of its fade from disabled, which is not what anyone sees.
  await expect(ann.getByRole("button", { name: "Next" })).toBeEnabled();
  await expectAccessible(ann);
  await shot(ann, "new-game-2-options");
  await ann.getByRole("button", { name: "Next" }).click();
  await ann.getByLabel("Their email address").fill(bobAddress);
  await expectAccessible(ann);
  await shot(ann, "new-game-3-players");
  await ann.getByRole("button", { name: "Review" }).click();
  await expect(ann.getByText(`Check the address: ${bobAddress}`)).toBeVisible();
  await expectAccessible(ann);
  await ann.getByRole("button", { name: "Create game" }).click();

  // The lobby, as the creator and as the invitee.
  await expect(ann.getByRole("heading", { level: 1 })).toHaveText("Words lobby");
  await expect(ann.getByRole("region", { name: "Players" })).toContainText("Invited");
  await expectAccessible(ann);
  await shot(ann, "lobby-creator");
  const gameId = /\/g\/([^/]+)$/u.exec(new URL(ann.url()).pathname)?.[1] ?? "";

  await bob.goto("/");
  const invitations = bob.getByRole("region", { name: /Invitations/u });
  await expect(invitations).toContainText("Invitation");
  await expectAccessible(bob);
  await shot(bob, "home-invitation");
  await invitations.getByRole("link", { name: /Words with Ann/u }).click();
  await expect(bob.getByText("Ann invited you to play.")).toBeVisible();
  await expectAccessible(bob);
  await shot(bob, "lobby-invitee");
  await bob.getByRole("button", { name: "Accept" }).click();

  // Everyone has joined, so the game starts by itself: Bob at once, Ann through her page's poll.
  await expect(bob.getByRole("region", { name: "Words board" })).toBeVisible(FAR);
  await expect(ann.getByRole("region", { name: "Words board" })).toBeVisible(FAR);

  const words = await loadWordList(ann, gameId);
  // The shell has cached the public word list for the board's previews.
  await expect
    .poll(() =>
      ann.evaluate(async () => (await (await caches.open("dictionaries-v1")).keys()).length),
    )
    .toBe(1);

  // Real moves: whoever's turn it is plays; both pages refocus first, as a person returning would.
  const players = [
    { page: ann, name: "Ann", plays: 0 },
    { page: bob, name: "Bob", plays: 0 },
  ];
  const whoseTurn = async () => {
    for (const player of players) if (await isMyTurn(player.page)) return player;
    return undefined;
  };
  let first = true;
  // Bounded by rounds and by time, so a stuck game fails an assertion below, not the test timeout.
  const deadline = Date.now() + GAME_LOOP_BUDGET_MS;
  for (let round = 0; round < 40 && players.some((p) => p.plays < 2); round += 1) {
    if (Date.now() > deadline) break;
    for (const player of players) await refocus(player.page);
    await expect.poll(async () => (await whoseTurn())?.name ?? "", FAR).not.toBe("");
    const mover = await whoseTurn();
    if (mover === undefined) throw new Error("nobody's turn");
    if (first) {
      await expectAccessible(mover.page);
      await shot(mover.page, "game-in-progress");
      first = false;
    }
    if (await takeTurn(mover.page, words)) mover.plays += 1;
    await expect.poll(() => isMyTurn(mover.page), FAR).toBe(false);
  }
  expect(Math.min(...players.map((p) => p.plays))).toBeGreaterThanOrEqual(2);
  // Both people scored, as both pages' score bars say.
  for (const player of players) {
    await refocus(player.page);
    await expect
      .poll(async () => {
        const scores = await scoresOf(player.page);
        return scores.length === 2 && scores.every((score) => score > 0);
      }, FAR)
      .toBe(true);
  }

  // The history drawer lists the moves the module's way, oldest first.
  await refocus(ann);
  await ann.getByRole("button", { name: "Menu" }).click();
  await expectAccessible(ann);
  await shot(ann, "menu");
  await ann.getByRole("button", { name: "History" }).click();
  const moves = ann.getByRole("list", { name: "Moves, oldest first" });
  await expect(moves).toBeVisible();
  expect(await moves.getByRole("listitem").count()).toBeGreaterThanOrEqual(4);
  await expectAccessible(ann);
  await shot(ann, "history");
  await ann.keyboard.press("Escape");
  await expect(ann.getByRole("dialog")).toHaveCount(0);
  // Focus is back on the Menu button, which opened the menu the drawer was opened from.
  await expect(ann.getByRole("button", { name: "Menu" })).toBeFocused();

  // Bob resigns from the menu, after being asked, and changes his mind once.
  await refocus(bob);
  await bob.getByRole("button", { name: "Menu" }).click();
  await bob.getByRole("button", { name: "Resign…" }).click();
  await expect(bob.getByRole("dialog", { name: "Resign this game?" })).toBeVisible();
  await expectAccessible(bob);
  await shot(bob, "resign-confirm");
  await bob.getByRole("button", { name: "Keep playing" }).click();
  await expect(bob.getByRole("dialog")).toHaveCount(0);
  await expect(bob.getByRole("button", { name: "Menu" })).toBeFocused();
  await bob.getByRole("button", { name: "Menu" }).click();
  await bob.getByRole("button", { name: "Resign…" }).click();
  await bob.getByRole("dialog").getByRole("button", { name: "Resign" }).click();

  // Both see the finished game: Bob's resignation is a loss, so Ann ranks first.
  for (const [page, first] of [
    [bob, "Ann"],
    [ann, "You"],
  ] as const) {
    await refocus(page);
    const results = page.getByRole("region", { name: "Final result" });
    await expect(results).toBeVisible(FAR);
    const rows = results.getByRole("listitem");
    await expect(rows.nth(0)).toContainText(first);
    await expect(rows.nth(1)).toContainText("resigned");
    await expectAccessible(page);
  }
  await shot(ann, "finished");
  await shot(bob, "finished-resigner");

  // The finished game moves to the collapsed Finished section of both lists.
  await ann.getByRole("link", { name: "Back to games" }).click();
  await expect(ann.getByText(/^Finished \(1\)/u)).toBeVisible();
  await expect(ann.getByRole("region", { name: /Your turn|Waiting/u })).toHaveCount(0);
  await shot(ann, "home-finished");

  // The worker answered no API request for either person, and Cache Storage holds the shell plus
  // the word list the game downloaded, nothing else.
  expect(fromWorker.map((seen) => seen.api)).toEqual([[], []]);
  // Positive control: the worker was answering (shell files), so the empty list above means
  // something. Playwright reports `fromServiceWorker()` in every project this suite runs.
  for (const seen of fromWorker) expect(seen.assets.length).toBeGreaterThan(0);
  for (const page of [ann, bob]) await expectOnlyShellAndWordLists(page, request);

  // Signing out wipes the per-game state this device kept (06 §4).
  await ann.evaluate(() => {
    localStorage.setItem("ym.game.words.u.g", "[0,1]");
  });
  await ann.goto("/settings");
  await ann.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(ann).toHaveURL(/\/signin$/u);
  expect(await ann.evaluate(() => localStorage.getItem("ym.game.words.u.g"))).toBeNull();
});

test("a game can be resigned straight after it starts", async ({ page: ann, friend: bob }) => {
  test.setTimeout(RESIGN_TEST_TIMEOUT_MS);
  const bobAddress = freshAddress();
  await signUp(ann, freshAddress(), "Ann");
  await signUp(bob, bobAddress, "Bob");
  await createAndAccept(ann, bob, bobAddress);
  await expect(bob.getByRole("region", { name: "Words board" })).toBeVisible(FAR);

  // The game is under way for both, and Bob's list shows it among the games waiting on someone.
  await refocus(ann);
  await expect(ann.getByRole("region", { name: "Words board" })).toBeVisible(FAR);

  // Whose turn it is is plain, and a tile placed off turn is marked as a plan (07 §2).
  const [waiting, acting] =
    (await ann.locator('.ym-w-turn[data-yours="true"]').count()) === 0 ? [ann, bob] : [bob, ann];
  await expect(acting.locator('.ym-w-turn[data-yours="true"]')).toHaveText("Your turn");
  await expect(waiting.locator('.ym-w-turn[data-yours="false"]')).toContainText(/'s turn$/u);
  await waiting.getByRole("group", { name: "Your rack" }).getByRole("button").first().click();
  await waiting.locator("[data-square]").nth(112).click();
  await expect(waiting.locator('.ym-w-tile[data-state="planned"]')).toHaveCount(1);
  await expect(waiting.getByRole("button", { name: /Planned tile/u })).toHaveCount(1);
  await expect(waiting.getByRole("button", { name: "Play", exact: true })).toBeDisabled();
  await expectAccessible(waiting);
  await waiting.getByRole("button", { name: "Recall" }).click();
  await expect(waiting.locator('.ym-w-tile[data-state="planned"]')).toHaveCount(0);

  // On the smallest supported phone the board's top is on the first screen (02 §3).
  await ann.setViewportSize({ width: 320, height: 568 });
  const board = ann.getByRole("region", { name: "Words board" });
  await expect(board).toBeVisible();
  expect(await ann.evaluate(() => window.scrollY)).toBe(0);
  expect((await board.boundingBox())?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(568);
  const firstSquare = ann.locator("[data-square]").first();
  expect((await firstSquare.boundingBox())?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(568);
  await ann.getByRole("link", { name: "Games", exact: true }).click();
  await expect(ann.getByRole("region", { name: /Your turn|Waiting/u })).toBeVisible();
  await expectAccessible(ann);
  await shot(ann, "home-in-progress");

  await ann.getByRole("link", { name: /Words with Bob/u }).click();
  await ann.getByRole("button", { name: "Menu" }).click();
  await ann.getByRole("button", { name: "Resign…" }).click();
  await ann.getByRole("dialog").getByRole("button", { name: "Resign" }).click();
  await expect(ann.getByRole("heading", { level: 2, name: "Final result" })).toBeVisible(FAR);
  await refocus(bob);
  await expect(bob.getByRole("heading", { level: 2, name: "Final result" })).toBeVisible(FAR);
  await expect(bob.getByRole("region", { name: "Final result" })).toContainText("resigned");
});
