/**
 * Plays the words game through the page like a person: reads the board and the rack from their
 * accessible names, finds a play in the public word list and places the tiles by tapping. A test
 * double for a player, not a strategy: it makes any legal play, and passes when it finds none.
 */
import type { Locator, Page } from "@playwright/test";

import { expect } from "./fixtures.js";

interface Square {
  readonly row: number;
  readonly col: number;
}

interface Board {
  readonly size: number;
  /** The letter on each occupied square, by `row,col` (0-based). */
  readonly tiles: ReadonlyMap<string, string>;
}

const key = (row: number, col: number): string => `${String(row)},${String(col)}`;

/** The words of the public list the game uses, as the envelope's download URL gives them. */
export async function loadWordList(page: Page, gameId: string): Promise<Set<string>> {
  const game = await page.request.get(`/api/v1/games/${gameId}`);
  const { game: envelope } = (await game.json()) as {
    game: { resources: { downloadUrl?: string }[] };
  };
  const url = envelope.resources[0]?.downloadUrl;
  if (url === undefined) throw new Error("the game has no public word list to play from");
  const text = await (await page.request.get(url)).text();
  return new Set(text.split("\n").filter((word) => word !== ""));
}

/** What is on the board now, read from the squares' accessible names. */
async function readBoard(page: Page): Promise<Board> {
  const squares = await page.locator("[data-square]").evaluateAll((elements) =>
    elements.map((element) => ({
      at: element.getAttribute("data-square") ?? "",
      label: element.getAttribute("aria-label") ?? "",
    })),
  );
  const tiles = new Map<string, string>();
  for (const { at, label } of squares) {
    if (label.endsWith("empty")) continue;
    const blank = /Blank tile standing for ([A-Z])/u.exec(label)?.[1];
    const letter = blank ?? /, ([A-Z]), \d+ points?/u.exec(label)?.[1];
    if (letter !== undefined) tiles.set(at, letter.toLowerCase());
  }
  return { size: Math.round(Math.sqrt(squares.length)), tiles };
}

/** The rack's letters (`?` for a blank). */
async function readRack(page: Page): Promise<string[]> {
  const labels = await page
    .getByRole("group", { name: "Your rack" })
    .locator("button[data-rack-id]")
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label") ?? ""));
  return labels.map((label) => (label.startsWith("Blank") ? "?" : label.slice(0, 1).toLowerCase()));
}

const take = (rack: string[], letter: string): boolean => {
  const at = rack.indexOf(letter);
  if (at < 0) return false;
  rack.splice(at, 1);
  return true;
};

/** The longest word (2 to 5 letters) the rack spells without a blank. */
function spell(rack: readonly string[], words: ReadonlySet<string>): string | null {
  let best: string | null = null;
  for (const word of words) {
    if (word.length < 2 || word.length > 5 || (best !== null && word.length <= best.length)) {
      continue;
    }
    const left = [...rack];
    if (Array.from(word).every((letter) => take(left, letter))) best = word;
  }
  return best;
}

/** A first play: a word laid left to right from the centre square. */
function openingPlay(
  board: Board,
  rack: readonly string[],
  words: ReadonlySet<string>,
): { square: Square; letter: string }[] | null {
  const word = spell(rack, words);
  if (word === null) return null;
  const centre = Math.floor(board.size / 2);
  return Array.from(word).map((letter, at) => ({
    square: { row: centre, col: centre + at },
    letter,
  }));
}

/** The whole run of letters through a square, read across or down, with `letter` on it. */
function runThrough(
  board: Board,
  at: Square,
  letter: string,
  step: readonly [number, number],
): string {
  const [dr, dc] = step;
  let before = "";
  for (let r = at.row - dr, c = at.col - dc; board.tiles.has(key(r, c)); r -= dr, c -= dc) {
    before = (board.tiles.get(key(r, c)) ?? "") + before;
  }
  let after = "";
  for (let r = at.row + dr, c = at.col + dc; board.tiles.has(key(r, c)); r += dr, c += dc) {
    after += board.tiles.get(key(r, c)) ?? "";
  }
  return before + letter + after;
}

/** A later play: one tile beside a tile on the board, so that every word it makes is in the list. */
function singleTilePlay(
  board: Board,
  rack: readonly string[],
  words: ReadonlySet<string>,
): { square: Square; letter: string }[] | null {
  for (let row = 0; row < board.size; row += 1) {
    for (let col = 0; col < board.size; col += 1) {
      if (board.tiles.has(key(row, col))) continue;
      const touching = [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
      ].some(([dr = 0, dc = 0]) => board.tiles.has(key(row + dr, col + dc)));
      if (!touching) continue;
      for (const letter of new Set(rack)) {
        if (letter === "?") continue;
        const runs = [
          runThrough(board, { row, col }, letter, [0, 1]),
          runThrough(board, { row, col }, letter, [1, 0]),
        ].filter((run) => run.length > 1);
        if (runs.length > 0 && runs.every((run) => words.has(run))) {
          return [{ square: { row, col }, letter }];
        }
      }
    }
  }
  return null;
}

/** A tap on a touch device (the iPhone), a click on one without touch. */
async function press(target: Locator): Promise<void> {
  const touch = await target.page().evaluate(() => navigator.maxTouchPoints > 0);
  await (touch ? target.tap() : target.click());
}

/** Taps each tile on the rack, then its square. */
async function place(
  page: Page,
  play: readonly { square: Square; letter: string }[],
): Promise<void> {
  for (const { square, letter } of play) {
    await press(
      page
        .getByRole("group", { name: "Your rack" })
        .getByRole("button", { name: new RegExp(`^${letter.toUpperCase()}, \\d+ points?$`, "u") })
        .first(),
    );
    await press(page.locator(`[data-square="${key(square.row, square.col)}"]`));
  }
}

/** Passes the turn through the board's own dialog. */
export async function pass(page: Page): Promise<void> {
  await press(page.getByRole("button", { name: "Pass", exact: true }));
  await press(
    page.getByRole("dialog", { name: "Pass your turn?" }).getByRole("button", { name: "Pass" }),
  );
}

/** Makes a play on the page, or passes; resolves to whether it was a play. */
export async function takeTurn(page: Page, words: ReadonlySet<string>): Promise<boolean> {
  const board = await readBoard(page);
  const rack = await readRack(page);
  const play =
    board.tiles.size === 0 ? openingPlay(board, rack, words) : singleTilePlay(board, rack, words);
  if (play === null) {
    await pass(page);
    return false;
  }
  await place(page, play);
  // The board checks the words with the server before it lets the player be sure.
  await expect(page.getByText("All words are in the word list.")).toBeVisible();
  await press(page.getByRole("button", { name: "Play", exact: true }));
  return true;
}
