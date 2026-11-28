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
 * The marker phase's two steps (paths §8), by touch: tap the edge square, then tap the first free
 * notch of the large buttons it opens. Returns the smallest side, in CSS px, of any button the
 * picker shows (the notches and "Choose another square"), which must be 44 or more.
 */
export async function placeMarker(page: Page, r: number, c: number): Promise<number> {
  await page.locator(`[data-r="${String(r)}"][data-c="${String(c)}"]`).tap();
  const picker = page.getByRole("group", {
    name: `Row ${String(r + 1)}, column ${String(c + 1)}: choose a notch`,
  });
  await expect(picker).toBeVisible();
  const boxes = await Promise.all(
    (await picker.getByRole("button").all()).map((button) => button.boundingBox()),
  );
  const smallest = Math.min(...boxes.map((box) => Math.min(box?.width ?? 0, box?.height ?? 0)));
  await expect(picker.getByRole("button", { name: "Choose another square" })).toBeVisible();
  await picker
    .getByRole("button", { name: /, free$/u })
    .first()
    .tap();
  return smallest;
}

/** What a turn did, as the player saw it before placing. */
export interface Turn {
  /** Whether the tile placed puts the player's own marker off the board. */
  readonly eliminated: boolean;
}

/**
 * Chooses a tile and a turn of it whose name says the player's marker would do the first of
 * `prefer` that any tile and turn in hand allows, checks the ghost preview is drawn, and places it
 * by touch. Returns what was placed.
 */
export async function playTile(
  page: Page,
  prefer: readonly ("survive" | "be eliminated")[],
): Promise<Turn> {
  const hand = page.getByRole("group", { name: "Your hand" }).getByRole("button");
  const count = await hand.count();
  let found = false;
  for (const want of prefer) {
    for (let i = 0; i < count && !found; i += 1) {
      const tile = hand.nth(i);
      await tile.tap();
      for (let turn = 0; turn < 4 && !found; turn += 1) {
        if (((await tile.getAttribute("aria-label")) ?? "").endsWith(want)) found = true;
        else await page.getByRole("button", { name: /Rotate/u }).tap();
      }
    }
    if (found) break;
  }
  if (!found) await hand.first().tap();
  // The ghost: the tile on the target square, every moved marker's trace, and the plain words.
  await expect(page.locator('[data-target="true"][data-ghost="true"]')).toHaveCount(1);
  expect(await page.locator(".ym-p-trace-group").count()).toBeGreaterThanOrEqual(1);
  const status = (await page.locator(".ym-p-status").textContent()) ?? "";
  const eliminated = status.includes("Warning: your marker would run off the board");
  await page.getByRole("button", { name: "Place", exact: true }).tap();
  return { eliminated };
}

/** The names of the players the page's list shows as still in the game, in seat order. */
export async function alive(page: Page, names: readonly string[]): Promise<string[]> {
  const items = await page.locator('.ym-p-players li[data-out="false"]').allTextContents();
  return names.filter((name) => items.some((text) => text.startsWith(name)));
}
