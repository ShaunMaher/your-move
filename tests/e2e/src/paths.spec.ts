/**
 * Four people play a paths game on phones (alpha A24, M5 acceptance, paths §8): the creator
 * makes a game for four with "Anything goes" and a join link, three others sign up from the link
 * on screens from 320 px wide, the creator starts it, each places a marker in two steps, five tiles
 * are placed (the last player trying one that puts their own marker off the board, which the
 * variant allows), and three players resign so the last marker left wins. Every page's board and
 * the finished game are checked for serious accessibility violations, and the fixtures fail any
 * test on a Content-Security-Policy violation. With `SHOTS_DIR` set, screenshots of the board in
 * both themes are written there.
 */
import type { Page } from "@playwright/test";

import { PATHS_TEST_TIMEOUT_MS } from "./budgets.js";
import { expect, test } from "./fixtures.js";
import { FAR, refocus, shot, shotBothThemes } from "./game-steps.js";
import { codeFrom, expectAccessible, freshAddress, requestCodeFor, signUp } from "./helpers.js";
import { alive, isMyTurn, placeMarker, playTile, tilesOnBoard } from "./paths-player.js";

// Phones: touch in every context (the project's own device settings already have it on iPhone).
test.use({ hasTouch: true, isMobile: true });

/** Screens from the smallest supported phone up; the corners each player's marker starts in. */
const SEATS = [
  { name: "Ann", width: 320, height: 568, corner: [0, 0] },
  { name: "Bob", width: 360, height: 640, corner: [0, 5] },
  { name: "Cy", width: 390, height: 844, corner: [5, 5] },
  { name: "Di", width: 414, height: 896, corner: [5, 0] },
] as const;

/** A person joining from the link: sign-up on the way, then Join on the link's page. */
async function joinFromLink(page: Page, token: string, name: string): Promise<void> {
  await page.goto(`/join#${token}`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const address = freshAddress();
  await requestCodeFor(page, address);
  await page.getByLabel("Sign-in code").fill(await codeFrom(page.request, address, 0));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("I'm 13 or older").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Join Paths");
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Paths lobby");
}

/** The board fits the screen: no sideways scroll, squares of 48 px or more at 320 px. */
async function expectFits(page: Page, width: number, height: number): Promise<void> {
  const fit = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(fit.scroll).toBeLessThanOrEqual(fit.inner);
  // The board's top is on the first screen (02 §3).
  const board = await page.getByRole("region", { name: "Paths board" }).boundingBox();
  const frame = await page.locator(".ym-p-stage").boundingBox();
  expect(frame?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(height);
  expect(board?.width ?? 0).toBeLessThanOrEqual(width);
  const square = await page.locator("[data-r][data-c]").first().boundingBox();
  const expected = Math.min(56 * (4 / 3), (width - 32) / 6);
  expect(square?.width ?? 0).toBeGreaterThanOrEqual(Math.floor(expected) - 1);
}

test("four people play a paths game from a join link and the last marker left wins", async ({
  page: ann,
  friend: bob,
  crowd: [cy, di],
}) => {
  test.setTimeout(PATHS_TEST_TIMEOUT_MS);
  if (cy === undefined || di === undefined) throw new Error("the crowd is two people");
  const pages = [ann, bob, cy, di];
  await Promise.all(
    pages.map((page, i) =>
      page.setViewportSize({ width: SEATS[i]?.width ?? 320, height: SEATS[i]?.height ?? 568 }),
    ),
  );

  // Ann makes a game for four with a join link; the options are the paths game's own form.
  await signUp(ann, freshAddress(), "Ann");
  await ann.getByRole("link", { name: "New game" }).click();
  await ann.getByRole("button", { name: /^Paths/u }).click();
  await expect(ann.getByRole("heading", { name: /options/u })).toBeVisible();
  await expect(ann.getByRole("button", { name: "Next" })).toBeEnabled();
  await expect(ann.getByRole("radio", { name: /Protect your marker/u })).toBeChecked();
  await ann.getByRole("radio", { name: /Anything goes/u }).check();
  await expectAccessible(ann);
  await shot(ann, "paths-options");
  await ann.getByRole("button", { name: "Next" }).click();
  await ann.getByLabel("Number of players").selectOption("4");
  await ann.getByRole("checkbox", { name: "Add a join link for the open seats" }).check();
  await ann.getByRole("button", { name: "Review" }).click();
  await ann.getByRole("button", { name: "Create game" }).click();
  await expect(ann.getByRole("heading", { level: 1 })).toHaveText("Paths lobby");
  const link = new URL(await ann.getByLabel(/Share this link/u).inputValue());
  const token = link.hash.slice(1);
  expect(link.pathname).toBe("/join");

  // The other three join from it, one after another, so the seats are in this order.
  await joinFromLink(bob, token, "Bob");
  await joinFromLink(cy, token, "Cy");
  await joinFromLink(di, token, "Di");
  await refocus(ann);
  await expect(ann.getByRole("listitem").filter({ hasText: "Di" })).toBeVisible(FAR);
  await ann.getByRole("button", { name: "Start game" }).click();
  for (const page of pages) {
    await refocus(page);
    await expect(page.getByRole("region", { name: "Paths board" })).toBeVisible(FAR);
  }

  // The marker phase, in turn order: tap an edge square, then a notch from the large buttons.
  for (const [i, seat] of SEATS.entries()) {
    const page = pages[i];
    if (page === undefined) throw new Error("no page");
    await refocus(page);
    await expect.poll(() => isMyTurn(page), FAR).toBe(true);
    await expect(page.getByText("Your turn: choose where your marker starts.")).toBeVisible();
    await expectFits(page, seat.width, seat.height);
    if (i === 0) {
      await expectAccessible(page);
      await shot(page, "paths-marker-phase-320");
    }
    const height = await placeMarker(page, seat.corner[0], seat.corner[1]);
    expect(height).toBeGreaterThanOrEqual(44);
    await expect.poll(() => isMyTurn(page), FAR).toBe(false);
  }
  for (const page of pages) {
    await refocus(page);
    // Every marker is on the board, in four shapes, and the tile phase has begun.
    await expect(page.getByRole("list", { name: "Players" }).getByRole("listitem")).toHaveText(
      [/Ann/u, /Bob/u, /Cy/u, /Di/u],
      FAR,
    );
    await expect(page.getByText(/^(Your turn: choose a tile\.|\w+'s turn\.)$/u)).toBeVisible(FAR);
    await expect(page.locator(".ym-p-over .ym-p-marker")).toHaveCount(4);
  }

  // Tile turns. Whoever is to play does. Until someone has gone out, each mover prefers a tile that
  // puts their own marker off the board (this game's option allows it): corner squares have
  // three other edge notches, so some tile and turn in a hand of three almost always does, and
  // the test goes on past five turns (to eight) until one is found, and fails if none is. No start
  // lets every tile eliminate (rule.test.ts counts which can't), so this is near-certain, not certain.
  let placed = 0;
  let eliminated: string | null = null;
  for (let turn = 0; turn < 5 || (eliminated === null && turn < 8); turn += 1) {
    for (const page of pages) await refocus(page);
    await expect
      .poll(
        async () => (await Promise.all(pages.map((page) => isMyTurn(page)))).includes(true),
        FAR,
      )
      .toBe(true);
    const index = (await Promise.all(pages.map((page) => isMyTurn(page)))).indexOf(true);
    const mover = pages[index];
    if (mover === undefined) throw new Error("nobody's turn");
    if (turn === 0) {
      await expectAccessible(mover);
      await shot(mover, `paths-tile-phase-${String(SEATS[index]?.width ?? 0)}`);
    }
    const result = await playTile(
      mover,
      eliminated === null ? ["be eliminated", "survive"] : ["survive", "be eliminated"],
    );
    placed += 1;
    if (result.eliminated && eliminated === null) eliminated = SEATS[index]?.name ?? null;
    await expect.poll(() => isMyTurn(mover), FAR).toBe(false);
    for (const page of pages) {
      await refocus(page);
      await expect(tilesOnBoard(page)).toHaveCount(placed, FAR);
    }
  }
  // The elimination is seen by everyone: the player is out in every page's list, and the pages
  // agree on who is still in (another seat may have gone out too, forced or by a collision).
  expect(
    eliminated,
    "someone's hand had a tile that puts their marker off the board",
  ).not.toBeNull();
  const names: string[] = SEATS.map((seat) => seat.name);
  await expect
    .poll(async () => {
      const lists = await Promise.all(pages.map((page) => alive(page, names)));
      const first = JSON.stringify(lists[0]);
      return (
        lists.every((list) => JSON.stringify(list) === first) &&
        !lists[0]?.includes(eliminated ?? "")
      );
    }, FAR)
    .toBe(true);
  await expectAccessible(ann);
  // The dark theme's colours are checked too.
  await ann.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(ann);
  await ann.emulateMedia({ colorScheme: "light" });
  await shotBothThemes(ann, "paths-board-320");
  await shotBothThemes(cy, "paths-board-390");

  // Everyone still in but one resigns, one after another: the last marker left wins.
  const standing = await alive(ann, names);
  const winner = standing[0] ?? "Ann";
  for (const name of standing.slice(1)) {
    const page = pages[names.indexOf(name)];
    if (page === undefined) throw new Error("no page");
    await refocus(page);
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("button", { name: "Resign…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Resign" }).click();
  }
  for (const page of pages) {
    await refocus(page);
    const results = page.getByRole("region", { name: "Final result" });
    await expect(results).toBeVisible(FAR);
    await expect(results.getByRole("listitem").first()).toContainText(
      page === pages[names.indexOf(winner)] ? "You" : winner,
    );
    await expect(page.getByRole("region", { name: "How it ended" })).toBeVisible();
  }
  await expectAccessible(ann);
  await shot(ann, "paths-finished-320");
});
