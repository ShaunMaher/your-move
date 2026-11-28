/**
 * Pairs on phones (alpha A26, pairs §9, 10 §Pairs game). Two tests:
 *
 * - Three people play a whole game from a join link on screens from 320 px wide, with touch: a
 *   match and its extra turn, a miss that the next player sees and that no page keeps in its markup
 *   once that player has turned a first card, a resignation mid-turn that turns the card back, and
 *   play to the end. The players are a test double with a perfect memory (pairs-player.ts), since
 *   the page itself forgets every face.
 * - The whole board is on the first screen at 320 × 568 for two and for four players on every grid,
 *   and every card is a touch target of at least 44 CSS px.
 *
 * Every page's board is checked for serious accessibility violations, and the fixtures fail any
 * test on a Content-Security-Policy violation. With `SHOTS_DIR` set, screenshots are written there.
 */
import type { Page } from "@playwright/test";

import { PAIRS_LAYOUT_TEST_TIMEOUT_MS, PAIRS_TEST_TIMEOUT_MS } from "./budgets.js";
import { expect, test } from "./fixtures.js";
import { FAR, refocus, shot, shotBothThemes } from "./game-steps.js";
import { expectAccessible, freshAddress, signUp } from "./helpers.js";
import {
  cardButtons,
  createPairsGame,
  joinFromLink,
  Memory,
  pristineBack,
  readCards,
  signUpFromLink,
  turnFirst,
  turnSecond,
  whoseTurn,
} from "./pairs-player.js";

// Phones: touch in every context (the project's own device settings already have it on iPhone).
test.use({ hasTouch: true, isMobile: true });

/** The columns of each grid, for the size a card must have at the smallest width. */
const COLUMNS = { "4x4": 4, "4x5": 4, "5x6": 5, "6x6": 6 } as const;

/**
 * The whole board is on the first screen, nothing scrolls sideways, and every card is a touch
 * target of at least 44 CSS px, of the size the spec gives (pairs §9).
 */
async function expectBoardFits(page: Page, columns: number): Promise<void> {
  // The first screen is the page scrolled to its top (the shell may have moved focus down it).
  const fit = await page.evaluate(() => {
    window.scrollTo(0, 0);
    return {
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
      height: window.innerHeight,
    };
  });
  expect(fit.scroll).toBeLessThanOrEqual(fit.inner);
  const buttons = await cardButtons(page).all();
  expect(buttons.length).toBeGreaterThan(0);
  const expected = Math.min(88, (fit.inner - 32 - (columns - 1) * 4) / columns);
  let bottom = 0;
  for (const button of buttons) {
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(Math.floor(expected) - 1);
    bottom = Math.max(bottom, (box?.y ?? 0) + (box?.height ?? 0));
  }
  // The board's last row ends above the bottom of the screen: the whole board is visible.
  expect(bottom).toBeLessThanOrEqual(fit.height);
}

/** The positions the page shows as the missed pair. */
async function missedCards(page: Page): Promise<number[]> {
  return (await readCards(page)).filter((cell) => cell.state === "missed").map((c) => c.index);
}

test("three people play a pairs game from a join link: a miss, a match, a resignation, the end", async ({
  page: ann,
  friend: bob,
  crowd: [cy],
}) => {
  test.setTimeout(PAIRS_TEST_TIMEOUT_MS);
  if (cy === undefined) throw new Error("the crowd is two people");
  const NAMES = ["Ann", "Bob", "Cy"];
  const pages = [ann, bob, cy];
  const WIDTHS = [
    { width: 320, height: 568 },
    { width: 360, height: 640 },
    { width: 390, height: 844 },
  ];
  await Promise.all(
    pages.map((page, i) => page.setViewportSize(WIDTHS[i] ?? { width: 320, height: 568 })),
  );

  // Ann makes a 4 × 5 game (the usual one) for three with a join link; the options are the pairs game's own form.
  await signUp(ann, freshAddress(), "Ann");
  await ann.getByRole("link", { name: "New game" }).click();
  await ann.getByRole("button", { name: /^Pairs/u }).click();
  await expect(ann.getByRole("heading", { name: /options/u })).toBeVisible();
  await expect(ann.getByRole("radio", { name: /^4 × 5: 10 pairs \(usual\)/u })).toBeChecked();
  await expectAccessible(ann);
  await shot(ann, "pairs-options");
  await ann.getByRole("button", { name: "Next" }).click();
  await ann.getByLabel("Number of players").selectOption("3");
  await ann.getByRole("checkbox", { name: "Add a join link for the open seats" }).check();
  await ann.getByRole("button", { name: "Review" }).click();
  await ann.getByRole("button", { name: "Create game" }).click();
  await expect(ann.getByRole("heading", { level: 1 })).toHaveText("Pairs lobby");
  const token = new URL(await ann.getByLabel(/Share this link/u).inputValue()).hash.slice(1);

  // The other two join from it, one after another, so the seats are in this order.
  await signUpFromLink(bob, token, "Bob");
  await signUpFromLink(cy, token, "Cy");
  await refocus(ann);
  await expect(ann.getByRole("listitem").filter({ hasText: "Cy" })).toBeVisible(FAR);
  await ann.getByRole("button", { name: "Start game" }).click();
  for (const [i, page] of pages.entries()) {
    await refocus(page);
    await expect(page.getByRole("region", { name: "Pairs board" })).toBeVisible(FAR);
    await expectBoardFits(page, 4);
    // Everyone sees the same 20 cards face down, with the players and numbers above them.
    await expect(cardButtons(page)).toHaveCount(20);
    expect((await readCards(page)).every((cell) => cell.state === "down")).toBe(true);
    await expect(page.getByRole("list", { name: "Players" }).getByRole("listitem")).toHaveText([
      /Ann/u,
      /Bob/u,
      /Cy/u,
    ]);
    if (i === 0) await expectAccessible(page);
  }
  await expect(ann.locator(".ym-pr-turn")).toHaveText("Your turn: turn over a card");
  await expect(bob.locator(".ym-pr-turn")).toHaveText("Ann to play");

  // Play. The double remembers every face it is shown; the boards forget them.
  const memory = new Memory();
  const moved = new Set<number>();
  let sawMatch = false;
  let sawMiss = false;
  let resigned = -1;
  let shotMid = false;
  let missedBefore: number[] = [];
  let missedBy = -1;

  /** The cards of the previous miss hold no face markup on any page once `first` has turned. */
  async function expectMissedGone(first: number): Promise<void> {
    for (const page of pages) {
      await refocus(page);
      await expect(page.locator('[data-state="missed"]')).toHaveCount(0, FAR);
      // The turn-down animation is over, and its node with it.
      await expect(page.locator(".ym-pr-ghost")).toHaveCount(0, FAR);
      const back = await pristineBack(page);
      for (const index of missedBefore.filter((i) => i !== first)) {
        const button = cardButtons(page).nth(index);
        const cell = (await readCards(page))[index];
        expect(cell?.label).toMatch(/, face down$/u);
        expect(await button.innerHTML()).toBe(back);
        expect(await button.evaluate((node) => node.outerHTML)).not.toMatch(
          /ym-pr-face|ym-pr-ghost|ym-pr-k\d|ym-pr-badge/u,
        );
      }
    }
    missedBefore = [];
  }

  for (let guard = 0; guard < 120; guard += 1) {
    for (const page of pages) await refocus(page);
    const finished = await ann.getByRole("region", { name: "Final result" }).count();
    if (finished > 0) break;
    const skip = new Set(resigned < 0 ? [] : [resigned]);
    const index = await whoseTurn(pages, skip);
    const page = pages[index];
    if (page === undefined) throw new Error("no page");

    // Once a match, a miss and a turn each have been seen, someone other than Ann who has already
    // moved turns a first card and resigns: the card turns back face down on every page.
    if (resigned < 0 && sawMatch && sawMiss && index !== 0 && moved.has(index)) {
      const first = await turnFirst(page, memory);
      if (missedBefore.length > 0) await expectMissedGone(first);
      await page.getByRole("button", { name: "Menu" }).click();
      await page.getByRole("button", { name: "Resign…" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Resign" }).click();
      resigned = index;
      for (const each of pages) {
        await refocus(each);
        await expect(cardButtons(each).nth(first)).toHaveAttribute("data-state", "down", FAR);
        await expect(each.locator(".ym-pr-ghost")).toHaveCount(0, FAR);
        expect(await cardButtons(each).nth(first).innerHTML()).toBe(await pristineBack(each));
        expect((await readCards(each))[first]?.label).toMatch(/, face down$/u);
        await expect(
          each.getByRole("list", { name: "Players" }).getByRole("listitem").nth(index),
        ).toContainText("out");
      }
      continue;
    }

    // The next player sees the missed pair, face up with the number of who missed it, and the
    // status line says so.
    if (missedBefore.length > 0) {
      const mine = await missedCards(page);
      expect(mine).toEqual(missedBefore);
      const badges = page.locator('[data-state="missed"] .ym-pr-badge');
      await expect(badges).toHaveCount(2);
      for (const badge of await badges.all()) {
        await expect(badge).toBeVisible();
        await expect(badge).toHaveAttribute("data-no", String(missedBy + 1));
      }
      await expect(page.locator(".ym-pr-status")).toContainText(
        /'s last turn: [a-z]+ \(row \d, column \d\) and [a-z]+ \(row \d, column \d\)\. They turn face down when you turn your first card\./u,
      );
      if (!shotMid && index === 1) {
        await expectAccessible(ann);
        await shotBothThemes(ann, "pairs-board-320");
        await shotBothThemes(cy, "pairs-board-390");
        shotMid = true;
      }
    }

    // Ann's first card is turned from the keyboard (arrow keys, Enter); the rest by touch.
    const first = await turnFirst(page, memory, guard === 0 ? 4 : undefined);
    if (missedBefore.length > 0) await expectMissedGone(first);
    moved.add(index);
    const { matched } = await turnSecond(page, memory, first);
    if (matched) {
      // A match scores the pair and keeps the turn, unless it was the last pair.
      sawMatch = true;
      const note = page.locator(".ym-pr-status");
      await expect(note).toContainText(/^A pair of [a-z]+!/u);
      if ((await note.textContent())?.includes("Your turn again.") === true) {
        await expect(page.locator(".ym-pr-turn")).toHaveAttribute("data-yours", "true");
      } else {
        await expect(page.getByRole("region", { name: "Final result" })).toBeVisible(FAR);
      }
    } else {
      sawMiss = true;
      missedBefore = await missedCards(page);
      missedBy = index;
      expect(missedBefore).toHaveLength(2);
      await expect(page.locator(".ym-pr-status")).toContainText(/^No match\. \w+ to play\./u);
    }
  }

  // The end: every page shows the result, how it ended in the board's words, and every card's face.
  for (const [i, page] of pages.entries()) {
    await refocus(page);
    await expect(page.getByRole("region", { name: "Final result" })).toBeVisible(FAR);
    const summary = page.getByRole("region", { name: "How it ended" });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("All the pairs were found.");
    await expect(summary).toContainText(`${NAMES[i] ?? ""} found`);
    expect((await readCards(page)).every((cell) => cell.face !== null)).toBe(true);
    await expect(page.locator(".ym-pr-turn")).toHaveCount(0);
  }
  expect(resigned).toBeGreaterThan(0);
  await expectAccessible(ann);
  await ann.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(ann);
  await ann.emulateMedia({ colorScheme: "light" });
  await shotBothThemes(ann, "pairs-finished-320");
});

test("the whole board is on the first screen at 320 by 568 for two and four players on every grid", async ({
  page: ann,
  friend: bob,
  crowd: [cy, di],
}) => {
  test.setTimeout(PAIRS_LAYOUT_TEST_TIMEOUT_MS);
  if (cy === undefined || di === undefined) throw new Error("the crowd is two people");
  const pages = [ann, bob, cy, di];
  await Promise.all(pages.map((page) => page.setViewportSize({ width: 320, height: 568 })));
  await signUp(ann, freshAddress(), "Ann");

  let joined = 1;
  /** A game for `players`, started, with every player's page on it. */
  async function play(grid: keyof typeof COLUMNS, players: number): Promise<void> {
    const token = await createPairsGame(ann, grid, players);
    for (const [i, page] of pages.slice(1, players).entries()) {
      if (i + 2 > joined) {
        await signUpFromLink(page, token, ["Bob", "Cy", "Di"][i] ?? "Bob");
        joined = i + 2;
      } else {
        await joinFromLink(page, token);
      }
    }
    await refocus(ann);
    await expect(ann.getByRole("button", { name: "Start game" })).toBeEnabled(FAR);
    await ann.getByRole("button", { name: "Start game" }).click();
    for (const page of pages.slice(0, players)) {
      await refocus(page);
      await expect(page.getByRole("region", { name: "Pairs board" })).toBeVisible(FAR);
      await expect(cardButtons(page)).toHaveCount(
        { "4x4": 16, "4x5": 20, "5x6": 30, "6x6": 36 }[grid],
      );
      await expectBoardFits(page, COLUMNS[grid]);
    }
    await expectAccessible(ann);
  }

  for (const grid of ["4x4", "4x5", "5x6", "6x6"] as const) {
    await play(grid, 2);
    await play(grid, 4);
    if (grid === "6x6") await shotBothThemes(ann, "pairs-6x6-320");
  }
});
