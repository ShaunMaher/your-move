/**
 * Plays the paths game through the page like a person: reads the hand from its accessible names,
 * turns a tile until it says what the player wants, and taps Place. A test double for a player,
 * not a strategy.
 */
import type { Locator, Page } from "@playwright/test";

import { expect } from "./fixtures.js";

/** Whether the page's board says it is this player's turn. */
export async function isMyTurn(page: Page): Promise<boolean> {
  return (await page.locator('.ym-p-turn[data-yours="true"]').count()) > 0;
}

/** The squares of the board that hold a tile, by their accessible names. */
export function tilesOnBoard(page: Page): Locator {
  return page.locator('[data-r][aria-label$="tile placed"]');
}

/**
 * The marker phase's two steps (paths §8): tap the edge square, then pick the first free notch of
 * the large buttons it opens. Returns the notch button's height, which must be 44 or more.
 */
export async function placeMarker(page: Page, r: number, c: number): Promise<number> {
  await page.locator(`[data-r="${String(r)}"][data-c="${String(c)}"]`).click();
  const picker = page.getByRole("group", {
    name: `Row ${String(r + 1)}, column ${String(c + 1)}: choose a notch`,
  });
  await expect(picker).toBeVisible();
  const notch = picker.getByRole("button", { name: /, free$/u }).first();
  const box = await notch.boundingBox();
  await notch.click();
  return box?.height ?? 0;
}

/** What a turn did, as the player saw it before placing. */
export interface Turn {
  /** Whether the tile placed would have put the player's own marker off the board. */
  readonly eliminated: boolean;
  /** The status text under the board at that moment. */
  readonly status: string;
}

/**
 * Chooses a tile and a turn of it whose name says the player's marker would `survive` or `be
 * eliminated` (the first tile as it is, if no choice does), checks the ghost preview is drawn,
 * and places it.
 */
export async function playTile(page: Page, want: "survive" | "be eliminated"): Promise<Turn> {
  const hand = page.getByRole("group", { name: "Your hand" }).getByRole("button");
  const count = await hand.count();
  let chosen: Locator | null = null;
  for (let i = 0; i < count && chosen === null; i += 1) {
    const tile = hand.nth(i);
    await tile.click();
    for (let turn = 0; turn < 4; turn += 1) {
      if (((await tile.getAttribute("aria-label")) ?? "").endsWith(want)) {
        chosen = tile;
        break;
      }
      await page.getByRole("button", { name: /Rotate/u }).click();
    }
  }
  if (chosen === null) await hand.first().click();
  // The ghost: the tile on the target square, every moved marker's trace, and the plain words.
  await expect(page.locator('[data-target="true"][data-ghost="true"]')).toHaveCount(1);
  expect(await page.locator(".ym-p-trace-group").count()).toBeGreaterThanOrEqual(1);
  const status = (await page.locator(".ym-p-status").textContent()) ?? "";
  const eliminated = status.includes("Warning: your marker would run off the board");
  await page.getByRole("button", { name: "Place", exact: true }).click();
  return { eliminated, status };
}
