/**
 * The no-play search (words §10.8): rule tables for what counts as a play, the step limit and
 * slices, the word list's prefix walk, and two properties. On a small board with small word lists,
 * where every play can be enumerated, the search agrees with a brute-force enumerator that asks
 * the engine's own `analysePlay` about every placement: "none" exactly when the enumerator finds
 * nothing. On random games under every bundled ruleset with the real built-in list, every play
 * the search returns is one the engine's `validate` accepts.
 */
import { isGameError, type RandomSource, type Resources } from "@your-move/sdk";
import { seededRandom } from "@your-move/testkit";
import { beforeAll, describe, expect, it } from "vitest";

import {
  board,
  options,
  rack,
  realDictionary,
  realWordList,
  ruleset,
  state,
  wordList,
} from "../test-support.js";
import { analysePlay, type Board, type BoardTile } from "./board.js";
import { wordsV1 as words } from "./definition.js";
import {
  hasAnyPlay,
  MAX_STEPS_PER_ACTION,
  searchPlays,
  type Lexicon,
  type SearchOutcome,
} from "./moves.js";
import { validate } from "./rules.js";
import { RULESETS } from "./rulesets/index.js";
import type { Ruleset } from "./rulesets/schema.js";
import type { Placement } from "./schemas.js";
import type { State } from "./state.js";

const CLASSIC = ruleset("classic");
const [SR, SC] = CLASSIC.start;
const PLENTY = 1_000_000;
const LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i));

/** A lexicon over these words (space-separated, any order). */
function lexicon(list: string): Lexicon {
  return wordList(list.split(/\s+/u).filter((word) => word !== ""));
}

function search(
  rules: Ruleset,
  grid: Board,
  tiles: string,
  list: Lexicon,
  maxSteps = PLENTY,
): SearchOutcome {
  return hasAnyPlay({ ruleset: rules, board: grid, rack: rack(tiles), lexicon: list, maxSteps });
}

/** Whether a play is legal on the board with every word in the list. */
function legal(
  rules: Ruleset,
  grid: Board,
  tiles: readonly string[],
  list: Lexicon,
  play: readonly Placement[],
): boolean {
  const analysis = analysePlay(rules, grid, tiles, play);
  return !isGameError(analysis) && analysis.words.every((w) => list.has(w.word));
}

/** A table row: a board, a rack, a word list, and whether some play exists. */
interface Row {
  readonly name: string;
  readonly board: Board;
  readonly rack: string;
  readonly words: string;
  readonly some: boolean;
  readonly rules?: Ruleset;
}

const withCat = board(CLASSIC, [{ row: SR, col: SC - 1, word: "cat" }]);
/** A small board with its start in the corner: openings can only run right or down. */
const CORNER: Ruleset = {
  ...CLASSIC,
  boardSize: 5,
  start: [0, 0],
  premiums: Array(5).fill("....."),
};

const ROWS: readonly Row[] = [
  {
    name: "an opening through the start square",
    board: board(CLASSIC),
    rack: "ta",
    words: "at",
    some: true,
  },
  {
    name: "no opening of a single tile",
    board: board(CLASSIC),
    rack: "a",
    words: "a at",
    some: false,
  },
  {
    name: "no opening without a word",
    board: board(CLASSIC),
    rack: "xq",
    words: "at",
    some: false,
  },
  {
    name: "an opening on a corner start, which can only run right or down",
    board: board(CORNER),
    rack: "ta",
    words: "at",
    some: true,
    rules: CORNER,
  },
  {
    name: "no opening longer than the board from a corner start",
    board: board(CORNER),
    rack: "abcdef",
    words: "abcdef",
    some: false,
    rules: CORNER,
  },
  { name: "a hook on the end of a word", board: withCat, rack: "s", words: "cat cats", some: true },
  { name: "a letter before a word", board: withCat, rack: "s", words: "cat scat", some: true },
  {
    name: "a single tile forming a word down only",
    board: withCat,
    rack: "x",
    words: "cat ax",
    some: true,
  },
  {
    name: "a play through a tile on the board",
    board: withCat,
    rack: "ee",
    words: "cat eae",
    some: true,
  },
  {
    name: "no play when every word it would form is missing",
    board: withCat,
    rack: "qz",
    words: "cat",
    some: false,
  },
  {
    name: "no parallel play when a cross-word isn't in the list",
    board: board(CLASSIC, [{ row: 0, col: 0, word: "cat" }]),
    rack: "oo",
    words: "cat oo",
    some: false,
  },
  {
    name: "a parallel play whose cross-words are all in the list",
    board: board(CLASSIC, [{ row: 0, col: 0, word: "at" }]),
    rack: "oo",
    words: "at oo ao to",
    some: true,
  },
  {
    name: "no play that runs into another tile and makes a longer non-word",
    board: board(CLASSIC, [
      { row: SR, col: SC, word: "ca" },
      { row: SR, col: SC + 3, word: "x" },
    ]),
    rack: "t",
    words: "cat",
    some: false,
  },
  {
    name: "a blank standing for a missing letter",
    board: withCat,
    rack: "?",
    words: "cat cats",
    some: true,
  },
  {
    name: "two blanks for a two-letter opening",
    board: board(CLASSIC),
    rack: "??",
    words: "qi",
    some: true,
  },
  { name: "no play from an empty rack", board: withCat, rack: "", words: "cat cats", some: false },
  {
    name: "a play at the board's edge",
    board: board(CLASSIC, [{ row: 14, col: 12, word: "ca" }]),
    rack: "t",
    words: "ca cat",
    some: true,
  },
  {
    name: "no play past the board's edge",
    board: board(CLASSIC, [{ row: 14, col: 12, word: "cat" }]),
    rack: "s",
    words: "cat cats",
    some: false,
  },
];

describe("hasAnyPlay", () => {
  it.each(ROWS)("$name", (row) => {
    const rules = row.rules ?? CLASSIC;
    const list = lexicon(row.words);
    const outcome = search(rules, row.board, row.rack, list);
    expect(outcome.kind).toBe(row.some ? "some" : "none");
    if (outcome.kind === "some") {
      expect(legal(rules, row.board, rack(row.rack), list, outcome.play)).toBe(true);
    }
  });

  it("plays a blank as a blank, with the letter it stands for", () => {
    const outcome = search(CLASSIC, withCat, "?", lexicon("cat cats"));
    expect(outcome).toEqual({
      kind: "some",
      play: [{ row: SR, col: SC + 2, tile: "?", letter: "s" }],
    });
  });

  it("uses a real tile before a blank for the same letter", () => {
    const outcome = search(CLASSIC, withCat, "s?", lexicon("cat cats"));
    expect(outcome).toEqual({ kind: "some", play: [{ row: SR, col: SC + 2, tile: "s" }] });
  });

  it("never plays more tiles than the ruleset's rack holds", () => {
    const small: Ruleset = { ...CLASSIC, rackSize: 2 };
    expect(search(small, board(small), "cat", lexicon("cat"))).toEqual({ kind: "none" });
    expect(search(small, board(small), "at", lexicon("at")).kind).toBe("some");
  });
});

describe("the step limit", () => {
  const list = lexicon("cat cats");

  it("says unknown, never none, when the search runs out of steps", () => {
    expect(search(CLASSIC, withCat, "qz", list, 10)).toEqual({ kind: "unknown" });
    expect(search(CLASSIC, withCat, "qz", list).kind).toBe("none");
  });

  it("runs in slices, stops at the answer, and keeps it", () => {
    const run = searchPlays({
      ruleset: CLASSIC,
      board: withCat,
      rack: ["q", "z"],
      lexicon: list,
      maxSteps: PLENTY,
    });
    let outcome: SearchOutcome | null = null;
    let slices = 0;
    while (outcome === null) {
      outcome = run.advance(1);
      slices += 1;
    }
    expect(outcome).toEqual({ kind: "none" });
    expect(slices).toBeGreaterThan(1);
    const used = run.steps;
    expect(run.advance(1)).toBe(outcome);
    expect(run.steps).toBe(used);
  });

  it("passes on any other failure, such as a word list that throws", () => {
    const broken: Lexicon = {
      has: () => {
        throw new Error("broken list");
      },
      follows: () => 1,
    };
    expect(() => search(CLASSIC, withCat, "a", broken)).toThrow("broken list");
  });

  it("takes the same steps whether run at once or in slices", () => {
    const whole = searchPlays({
      ruleset: CLASSIC,
      board: withCat,
      rack: ["q", "z"],
      lexicon: list,
      maxSteps: PLENTY,
    });
    whole.advance(PLENTY);
    const sliced = searchPlays({
      ruleset: CLASSIC,
      board: withCat,
      rack: ["q", "z"],
      lexicon: list,
      maxSteps: PLENTY,
    });
    while (sliced.advance(7) === null);
    expect(sliced.steps).toBe(whole.steps);
  });
});

describe("slices (A14-P-1)", () => {
  let all: string[];
  beforeAll(async () => {
    all = await realWordList();
  });

  /** Runs a search in slices of `budget`: the most any slice went over it, and the steps in all. */
  function slices(grid: Board, tiles: string, list: Lexicon, budget: number) {
    const run = searchPlays({
      ruleset: CLASSIC,
      board: grid,
      rack: rack(tiles),
      lexicon: list,
      maxSteps: PLENTY,
    });
    let worst = 0;
    for (let outcome = null as SearchOutcome | null; outcome === null;) {
      const before = run.steps;
      outcome = run.advance(budget);
      worst = Math.max(worst, run.steps - before - budget);
    }
    return { worst, steps: run.steps };
  }

  it.each([1, 7, 100, 5_000])(
    "never runs a slice of %i steps more than one action over, inside a unit too",
    (budget) => {
      // Every prefix of the real list and no word: an opening walk that used to run 60,000 steps
      // in one unit, and a busy board whose cross-checks are worked out square by square.
      const list = wordList(all);
      const noWords: Lexicon = { has: () => false, follows: (prefix) => list.follows(prefix) };
      for (const grid of [board(CLASSIC), withCat]) {
        const { worst, steps } = slices(grid, "?moeari", noWords, budget);
        expect(worst).toBeLessThan(MAX_STEPS_PER_ACTION);
        // Long enough that one unit spans many slices of the largest budget.
        expect(steps).toBeGreaterThan(20_000);
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Brute force on a small board.

/** A 7×7 board, rack of 4, no premiums: small enough to enumerate every play. */
const SMALL: Ruleset = {
  ...CLASSIC,
  boardSize: 7,
  start: [3, 3],
  rackSize: 4,
  premiums: Array(7).fill("......."),
};

/** Distinct orderings of `count` tiles drawn from `tiles`. */
function arrangements(tiles: readonly string[], count: number): string[][] {
  if (count === 0) return [[]];
  const found: string[][] = [];
  const used = new Set<string>();
  tiles.forEach((tile, i) => {
    if (used.has(tile)) return;
    used.add(tile);
    const rest = [...tiles.slice(0, i), ...tiles.slice(i + 1)];
    for (const tail of arrangements(rest, count - 1)) found.push([tile, ...tail]);
  });
  return found;
}

/**
 * Every legal play, found the dumb way: on each line, the tiles of a play fill every empty square
 * between its first and last tile (no gaps), so a play is a pair of empty end squares, an
 * ordering of rack tiles for the empty squares between them and a letter for each blank; the
 * engine's `analysePlay` and the word list judge each one.
 */
function allPlays(
  rules: Ruleset,
  grid: Board,
  tiles: readonly string[],
  list: Lexicon,
): Placement[][] {
  const size = rules.boardSize;
  const found: Placement[][] = [];
  for (const down of [false, true]) {
    for (let line = 0; line < size; line += 1) {
      const square = (i: number): [number, number] => (down ? [i, line] : [line, i]);
      const empty = (i: number): boolean => {
        const [row, col] = square(i);
        return grid[row]?.[col] == null;
      };
      for (let from = 0; from < size; from += 1) {
        for (let to = from; to < size; to += 1) {
          // A single tile is one play whichever line it is on: count it across only.
          if (down && from === to) continue;
          if (!empty(from) || !empty(to)) continue;
          const spots = [];
          for (let i = from; i <= to; i += 1) if (empty(i)) spots.push(square(i));
          if (spots.length > Math.min(tiles.length, rules.rackSize)) continue;
          const orders = arrangements(tiles, spots.length);
          // Where tiles may go doesn't depend on which tiles they are: a window the engine
          // refuses for one ordering (not connected, start not covered) it refuses for all.
          const probe = withLetters(spots, orders[0] ?? [])[0] ?? [];
          if (isGameError(analysePlay(rules, grid, tiles, probe))) continue;
          for (const order of orders) {
            for (const play of withLetters(spots, order)) {
              if (legal(rules, grid, tiles, list, play)) found.push(play);
            }
          }
        }
      }
    }
  }
  return found;
}

/** The placements of tiles on squares, once for every letter each blank could stand for. */
function withLetters(spots: readonly [number, number][], order: readonly string[]): Placement[][] {
  let plays: Placement[][] = [[]];
  spots.forEach(([row, col], i) => {
    const tile = order[i] ?? "";
    plays = plays.flatMap((so) =>
      tile === "?"
        ? LETTERS.map((letter) => [...so, { row, col, tile, letter }])
        : [[...so, { row, col, tile }]],
    );
  });
  return plays;
}

/** A random small word list over a few letters, so "no play" comes up often. */
function smallList(all: readonly string[], rng: RandomSource): Lexicon {
  const pool = all.filter((word) => word.length <= 4 && /^[aeiorstnlcd]+$/u.test(word));
  const picked = new Set<string>();
  const count = 60 + rng.nextInt(140);
  while (picked.size < count) picked.add(pool[rng.nextInt(pool.length)] ?? "");
  return wordList(picked);
}

/** A random rack: mostly the list's letters, some others, now and then a blank. */
function randomRack(rng: RandomSource): string[] {
  const size = 1 + rng.nextInt(SMALL.rackSize);
  return Array.from({ length: size }, () => {
    const roll = rng.nextInt(24);
    if (roll === 0) return "?";
    return roll < 16 ? ("aeiorstnlcd"[rng.nextInt(11)] ?? "a") : (LETTERS[rng.nextInt(26)] ?? "a");
  });
}

describe("against brute force on a small board", () => {
  let all: string[];
  beforeAll(async () => {
    all = await realWordList();
  });

  it("finds a play exactly when one exists, and only legal ones (200 random games)", () => {
    const tally = { some: 0, none: 0 };
    for (let game = 0; game < 200; game += 1) {
      const rng = seededRandom(game);
      const list = smallList(all, rng);
      let grid: (BoardTile | null)[][] = board(SMALL);
      for (let turn = 0; turn < 12; turn += 1) {
        const tiles = randomRack(rng);
        const plays = allPlays(SMALL, grid, tiles, list);
        const outcome = hasAnyPlay({
          ruleset: SMALL,
          board: grid,
          rack: tiles,
          lexicon: list,
          maxSteps: PLENTY,
        });
        const where = `game ${String(game)} turn ${String(turn)} rack ${tiles.join("")}`;
        expect(outcome.kind, where).toBe(plays.length > 0 ? "some" : "none");
        if (outcome.kind === "some") {
          expect(legal(SMALL, grid, tiles, list, outcome.play), where).toBe(true);
          tally.some += 1;
        } else {
          tally.none += 1;
        }
        // Play one of the plays at random, so later turns see a reachable, fuller board.
        const chosen = plays[rng.nextInt(Math.max(plays.length, 1))];
        if (chosen !== undefined) {
          grid = grid.map((cells) => [...cells]);
          for (const p of chosen) {
            const cells = grid[p.row];
            if (cells !== undefined) cells[p.col] = { tile: p.tile, letter: p.letter ?? p.tile };
          }
        }
      }
    }
    // Both answers come up often enough to mean something.
    expect(tally.some).toBeGreaterThan(400);
    expect(tally.none).toBeGreaterThan(400);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// Real games with the real list.

describe.each([...RULESETS.keys()])("random games under the %s ruleset", (id) => {
  let res: Resources;
  let list: Lexicon;
  beforeAll(async () => {
    res = (await realDictionary()).resources;
    list = wordList(await realWordList());
  });

  it("returns only plays the engine's validate accepts (40 games)", () => {
    const opts = options(id);
    const rules = ruleset(id);
    let checked = 0;
    for (let game = 0; game < 40; game += 1) {
      const rng = seededRandom(1000 + game);
      let now: State = words.setup({ options: opts, seats: 2, rng: seededRandom(game) });
      for (let turn = 0; words.result(now) === null && turn < 200; turn += 1) {
        const [seat = 0] = words.toAct(now);
        const tiles = now.racks[seat] ?? [];
        const outcome = hasAnyPlay({
          ruleset: rules,
          board: now.board,
          rack: tiles,
          lexicon: list,
          maxSteps: PLENTY,
        });
        expect(outcome.kind).not.toBe("unknown");
        if (outcome.kind === "some") {
          const verdict = validate(now, seat, { type: "play", placements: [...outcome.play] }, res);
          expect(verdict, `game ${String(game)} turn ${String(turn)}`).toEqual({ ok: true });
          checked += 1;
        }
        const action = words.test.randomAction(now, seat, rng, res);
        now = words.apply(now, seat, action, seededRandom(turn)).state;
      }
    }
    expect(checked).toBeGreaterThan(400);
  }, 120_000);

  it("finds no play for a rack the list can't use, and one once a blank arrives", () => {
    const rules = ruleset(id);
    const grid = state({ racks: [rack("e"), rack("e")], rulesetId: id }).board;
    expect(search(rules, grid, "vvq", list).kind).toBe("none");
    expect(search(rules, grid, "vvq?", list).kind).toBe("some");
  });
});
