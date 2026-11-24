/**
 * Test helpers for the words package: rulesets with chosen premiums, boards and states for rules
 * tables, placements written as words, small dictionaries, tile conservation, and the real
 * built-in word list for property tests. Never imported by the engine, client or manifest, and
 * left out of the published files.
 */
import { createWordList, toResourceMeta } from "@your-move/dictionary";
import { buildBuiltin } from "@your-move/dictionary/builder";
import type { ResourceMeta, Resources } from "@your-move/sdk";

import type { BoardTile } from "./engine/board.js";
import { latestRuleset } from "./engine/rulesets/index.js";
import type { Ruleset } from "./engine/rulesets/schema.js";
import type { Options, Placement, PlayAction } from "./engine/schemas.js";
import { allTiles, type State } from "./engine/state.js";

/** The id of the built-in dictionary the MVP ships (words §9.2). */
export const BUILTIN_ID = ["en", "able"].join("");

/** The latest version of a bundled ruleset. */
export function ruleset(id = "classic"): Ruleset {
  const found = latestRuleset(id);
  if (found === undefined) throw new Error(`no ruleset ${id}`);
  return found;
}

/** Resolved options for a bundled ruleset. */
export function options(id = "classic", dictionaryId = BUILTIN_ID): Options {
  return { rulesetId: id, rulesetVersion: 1, dictionaryId, dictionaryVersion: 1 };
}

/**
 * A copy of a ruleset whose only premiums are the given squares, keyed `"row,col"`, so scoring
 * tables don't depend on where a real layout puts its premiums.
 */
export function withPremiums(
  base: Ruleset,
  premiums: Readonly<Record<string, "d" | "t" | "D" | "T">>,
): Ruleset {
  const size = base.boardSize;
  const rows = Array.from({ length: size }, (_, row) =>
    Array.from(
      { length: size },
      (_unused, col) => premiums[`${String(row)},${String(col)}`] ?? ".",
    ).join(""),
  );
  return { ...base, premiums: rows };
}

/** A copy of a ruleset with no premium squares at all. */
export function plain(base: Ruleset = ruleset()): Ruleset {
  return withPremiums(base, {});
}

/** A word laid on the board: lower case is a tile, upper case a blank standing for that letter. */
export interface Laid {
  readonly row: number;
  readonly col: number;
  readonly word: string;
  readonly down?: boolean;
}

/** The squares a word covers, with its tiles. */
function squares({ row, col, word, down = false }: Laid): Placement[] {
  return word.split("").map((char, i) => {
    const [r, c] = down ? [row + i, col] : [row, col + i];
    const blank = char !== char.toLowerCase();
    return blank
      ? { row: r, col: c, tile: "?", letter: char.toLowerCase() }
      : { row: r, col: c, tile: char };
  });
}

/** A board of the ruleset's size with these words on it. */
export function board(rules: Ruleset, words: readonly Laid[] = []): (BoardTile | null)[][] {
  const size = rules.boardSize;
  const grid: (BoardTile | null)[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => null),
  );
  for (const laid of words) {
    for (const p of squares(laid)) {
      const row = grid[p.row];
      if (row === undefined) throw new Error("word off the board");
      row[p.col] = { tile: p.tile, letter: p.letter ?? p.tile };
    }
  }
  return grid;
}

/** A play of these words' new tiles (squares already filled on `on` are skipped). */
export function play(
  words: readonly Laid[],
  on: readonly (readonly (BoardTile | null)[])[] = [],
): PlayAction {
  const placements = words
    .flatMap(squares)
    .filter((p) => on[p.row]?.[p.col] === undefined || on[p.row]?.[p.col] === null);
  return { type: "play", placements };
}

/** A rack written as a string: letters and `?`. */
export function rack(tiles: string): string[] {
  return tiles.split("");
}

/** A dictionary over these words (space-separated). */
export function dictionary(words: string): Resources {
  const set = new Set(words.split(/\s+/u).filter((word) => word !== ""));
  return { dictionary: { id: BUILTIN_ID, version: 1, has: (word) => set.has(word) } };
}

/** Every tile in a state: board, racks and bag, sorted. */
export function tilesIn(state: State): string[] {
  return [
    ...state.bag,
    ...state.racks.flat(),
    ...state.board.flat().flatMap((square) => (square === null ? [] : [square.tile])),
  ].sort();
}

/** Whether a state holds exactly the ruleset's tiles (words §10.7). */
export function conserved(state: State, rules: Ruleset): boolean {
  return tilesIn(state).join("") === allTiles(rules).sort().join("");
}

/**
 * A state for a rules table: give the racks (and whatever else matters); the bag holds every
 * other tile of the ruleset, in a fixed order unless given.
 */
export function state(
  fields: Partial<Omit<State, "racks">> & { racks: string[][]; rulesetId?: string },
): State {
  const { rulesetId = "classic", ...rest } = fields;
  const rules = ruleset(rulesetId);
  const grid = fields.board ?? board(rules);
  const used = [
    ...fields.racks.flat(),
    ...grid.flat().flatMap((square) => (square === null ? [] : [square.tile])),
  ];
  const bag = allTiles(rules);
  for (const tile of used) {
    const index = bag.indexOf(tile);
    if (index === -1) throw new Error(`no tile ${tile} left for the fixture`);
    bag.splice(index, 1);
  }
  return {
    options: options(rulesetId),
    board: grid,
    bag,
    scores: fields.racks.map(() => 0),
    turn: 0,
    scorelessStreak: 0,
    lastMove: null,
    finished: null,
    ...rest,
  };
}

let builtin: Promise<{ meta: ResourceMeta; resources: Resources }> | undefined;

/** The real built-in dictionary (built in memory from its sources) as metadata and resources. */
export function realDictionary(): Promise<{ meta: ResourceMeta; resources: Resources }> {
  builtin ??= buildBuiltin(BUILTIN_ID).then(({ manifest, text }) => ({
    meta: toResourceMeta(manifest),
    resources: { dictionary: createWordList(manifest.id, manifest.version, text) },
  }));
  return builtin;
}
