/**
 * Plays the pairs game through the page like a person with a perfect memory: reads every card's
 * accessible name, remembers the faces it has been shown (the page itself forgets them), and
 * turns cards by touch. A test double for a player, not a strategy.
 */
import type { Locator, Page } from "@playwright/test";

import { expect } from "./fixtures.js";
import { codeFrom, freshAddress, requestCodeFor } from "./helpers.js";

/** One card as the page names it (pairs §9). */
export interface Cell {
  readonly index: number;
  readonly label: string;
  readonly state: string;
  readonly disabled: boolean;
  /** The face the name gives (`star`), or null for a card with no face shown. */
  readonly face: string | null;
}

const FACE_IN_NAME = /^Row \d+, column \d+, ([a-z]+),/u;

/** The card buttons of the page's board, in reading order. */
export const cardButtons = (page: Page): Locator =>
  page.getByRole("grid", { name: "Cards" }).getByRole("button");

/** Every card's name, state and whether it is inactive, in one round trip. */
export async function readCards(page: Page): Promise<Cell[]> {
  const raw = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[role="grid"][aria-label="Cards"] button')].map(
      (button, index) => ({
        index,
        label: button.getAttribute("aria-label") ?? "",
        state: button.dataset["state"] ?? "",
        disabled: button.getAttribute("aria-disabled") === "true",
      }),
    ),
  );
  return raw.map((cell) => ({ ...cell, face: FACE_IN_NAME.exec(cell.label)?.[1] ?? null }));
}

/** Whether the page's board says it is this player's turn. */
async function isMyTurn(page: Page): Promise<boolean> {
  return (await page.locator('.ym-pr-turn[data-yours="true"]').count()) > 0;
}

/** The markup of a card that shows its back, to compare other cards with. */
export async function pristineBack(page: Page): Promise<string> {
  return page.locator('[role="grid"] button[data-state="down"]').first().innerHTML();
}

/** What the page's player remembers: every face it has been shown, by card index. */
export class Memory {
  readonly faces = new Map<number, string>();

  learn(cells: readonly Cell[]): void {
    for (const cell of cells) if (cell.face !== null) this.faces.set(cell.index, cell.face);
  }

  /** Two cards known to match that are not yet matched, or null. */
  pair(cells: readonly Cell[]): [number, number] | null {
    const open = new Map<string, number>();
    for (const cell of cells) {
      const face = this.faces.get(cell.index);
      if (face === undefined || cell.state === "matched") continue;
      const other = open.get(face);
      if (other !== undefined) return [other, cell.index];
      open.set(face, cell.index);
    }
    return null;
  }

  /** The known, unmatched partner of `index` (a card with the same face), or null. */
  partner(cells: readonly Cell[], index: number): number | null {
    const face = this.faces.get(index);
    const found = cells.find(
      (cell) =>
        cell.index !== index && cell.state !== "matched" && this.faces.get(cell.index) === face,
    );
    return found?.index ?? null;
  }

  /** A card face down that this player has never been shown, else any face down. */
  unknown(cells: readonly Cell[], not: readonly number[] = []): number {
    const down = cells.filter((cell) => cell.state === "down" && !not.includes(cell.index));
    const fresh = down.find((cell) => !this.faces.has(cell.index));
    const found = fresh ?? down[0];
    if (found === undefined) throw new Error("no card is face down");
    return found.index;
  }
}

/**
 * Turns the card at `index` by keyboard, as a screen-reader or keyboard user would: focus the
 * board's first card, move with the arrow keys (`columns` to a row), then press Enter.
 */
async function turnByKeys(page: Page, index: number, columns: number): Promise<void> {
  await cardButtons(page).first().focus();
  for (let row = 0; row < Math.floor(index / columns); row += 1)
    await page.keyboard.press("ArrowDown");
  for (let column = 0; column < index % columns; column += 1)
    await page.keyboard.press("ArrowRight");
  await expect(cardButtons(page).nth(index)).toBeFocused();
  await page.keyboard.press("Enter");
}

/**
 * Turns the first card of a turn, by touch (or by keyboard when `columns` is given), and waits for
 * it to show. A known pair is taken first; otherwise a card never seen.
 */
export async function turnFirst(page: Page, memory: Memory, columns?: number): Promise<number> {
  const cells = await readCards(page);
  memory.learn(cells);
  const pair = memory.pair(cells);
  const first = pair === null ? memory.unknown(cells) : pair[0];
  if (columns === undefined) await cardButtons(page).nth(first).tap();
  else await turnByKeys(page, first, columns);
  await expect(cardButtons(page).nth(first)).toHaveAttribute("data-state", "up");
  memory.learn(await readCards(page));
  return first;
}

/** Turns the second card (its partner if it is known), and waits for the outcome to show. */
export async function turnSecond(
  page: Page,
  memory: Memory,
  first: number,
): Promise<{ second: number; matched: boolean }> {
  const cells = await readCards(page);
  const second = memory.partner(cells, first) ?? memory.unknown(cells, [first]);
  await cardButtons(page).nth(second).tap();
  const card = cardButtons(page).nth(second);
  await expect
    .poll(async () => card.getAttribute("data-state"), { timeout: 20_000 })
    .not.toBe("down");
  const after = await readCards(page);
  memory.learn(after);
  return { second, matched: after[second]?.state === "matched" };
}

/** Which of the pages is to play, once the pages have refreshed. */
export async function whoseTurn(
  pages: readonly Page[],
  skip: ReadonlySet<number> = new Set(),
): Promise<number> {
  let found = -1;
  await expect
    .poll(
      async () => {
        for (const [index, page] of pages.entries()) {
          if (!skip.has(index) && (await isMyTurn(page))) {
            found = index;
            return true;
          }
        }
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return found;
}

/** A new person, from the join link: sign-up on the way, then Join on the link's page. */
export async function signUpFromLink(page: Page, token: string, name: string): Promise<void> {
  await page.goto(`/join#${token}`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const address = freshAddress();
  await requestCodeFor(page, address);
  await page.getByLabel("Sign-in code").fill(await codeFrom(page.request, address, 0));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("I'm 13 or older").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Join Pairs");
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pairs lobby");
}

/** A person who is already signed in, joining from the link. */
export async function joinFromLink(page: Page, token: string): Promise<void> {
  await page.goto(`/join#${token}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Join Pairs");
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pairs lobby");
}

/**
 * The creator makes a pairs game on `grid` for `players` people with a join link, from the New
 * game screen, and gives the link's token. They end on the game's lobby.
 */
export async function createPairsGame(page: Page, grid: string, players: number): Promise<string> {
  await page.goto("/");
  await page.getByRole("link", { name: "New game" }).click();
  await page.getByRole("button", { name: /^Pairs/u }).click();
  await expect(page.getByRole("heading", { name: /options/u })).toBeVisible();
  await page.getByRole("radio", { name: new RegExp(`^${grid.replace("x", " × ")}`, "u") }).check();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByLabel("Number of players").selectOption(String(players));
  await page.getByRole("checkbox", { name: "Add a join link for the open seats" }).check();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Create game" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pairs lobby");
  const link = new URL(await page.getByLabel(/Share this link/u).inputValue());
  return link.hash.slice(1);
}
