/**
 * Property tests (10 M1, words §10.7), under every bundled ruleset with the real built-in word
 * list: thousands of random legal games played by the kit's bot with a seeded `RandomSource`.
 * After every transition the tiles are conserved (bag + racks + board = the ruleset's tiles), and
 * each finished game replays from its recorded draws to exactly the same state. The board also
 * stays legal (every run of two or more tiles is a word, all connected through the start square)
 * and every score is the sum of its plays plus its final adjustment, which sum to 0 for `out`.
 */
import { isGameError, recordRandom, replayRandom, type Resources, type Seat } from "@your-move/sdk";
import { seededRandom } from "@your-move/testkit";
import { beforeAll, describe, expect, it } from "vitest";

import {
  board,
  conserved,
  options,
  rack,
  realDictionary,
  ruleset,
  state,
} from "../test-support.js";
import { wordsV1 as words } from "./definition.js";
import { RULESETS } from "./rulesets/index.js";
import type { Action, PublicRecord } from "./schemas.js";
import type { State } from "./state.js";

/** Games per ruleset: 1000 each, so thousands across the bundled rulesets. */
const GAMES = 1000;

interface Entry {
  readonly seat: Seat;
  readonly kind: "action" | "resign" | "timeout";
  readonly action?: Action;
  readonly draws: readonly number[];
}

let res: Resources;
beforeAll(async () => {
  res = (await realDictionary()).resources;
});

type Grid = State["board"];

/** Every run of two or more tiles along a row or a column: the words on the board (§3.1 rule 6). */
function boardWords(board: Grid): string[] {
  const size = board.length;
  const found: string[] = [];
  const letter = (row: number, col: number): string | undefined => board[row]?.[col]?.letter;
  for (const across of [true, false]) {
    for (let line = 0; line < size; line += 1) {
      let run = "";
      for (let i = 0; i <= size; i += 1) {
        const l = across ? letter(line, i) : letter(i, line);
        if (l !== undefined) {
          run += l;
        } else {
          if (run.length >= 2) found.push(run);
          run = "";
        }
      }
    }
  }
  return found;
}

/** Whether the tiles cover the start square and are all connected to it (or there are none). */
function connectedThroughStart(
  board: Grid,
  [startRow, startCol]: readonly [number, number],
): boolean {
  const tiles = board.flat().filter((square) => square !== null).length;
  if (tiles === 0) return true;
  if (board[startRow]?.[startCol] == null) return false;
  const seen = new Set<string>();
  const queue: [number, number][] = [[startRow, startCol]];
  while (queue.length > 0) {
    const [row, col] = queue.pop()!;
    const key = `${String(row)},${String(col)}`;
    if (seen.has(key) || board[row]?.[col] == null) continue;
    seen.add(key);
    queue.push([row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]);
  }
  return seen.size === tiles;
}

/** Checks the board and score invariants after a transition; throws with the reason. */
function checkInvariants(
  state: State,
  start: readonly [number, number],
  earned: readonly number[],
): void {
  const invalid = boardWords(state.board).filter((word) => res.dictionary?.has(word) !== true);
  if (invalid.length > 0) throw new Error(`words not in the dictionary: ${invalid.join(" ")}`);
  if (!connectedThroughStart(state.board, start)) {
    throw new Error("the tiles aren't connected through the start square");
  }
  const adjustments = state.finished?.adjustments ?? earned.map(() => 0);
  state.scores.forEach((score, seat) => {
    if (score !== (earned[seat] ?? 0) + (adjustments[seat] ?? 0)) {
      throw new Error(`seat ${String(seat)}'s score isn't its plays plus its adjustment`);
    }
  });
  if (state.finished?.reason === "out" && adjustments.reduce((a, b) => a + b, 0) !== 0) {
    throw new Error("the adjustments of going out don't sum to 0");
  }
}

describe("the invariant checks themselves", () => {
  const rules = ruleset("classic");
  const [row, col] = rules.start;
  const base = state({ racks: [rack("e"), rack("e")] });
  it("pass a legal board and catch an illegal one", () => {
    const good = { ...base, board: board(rules, [{ row, col, word: "cat" }]) };
    expect(() => {
      checkInvariants(good, rules.start, [0, 0]);
    }).not.toThrow();
    const nonWord = { ...base, board: board(rules, [{ row, col, word: "xqz" }]) };
    expect(() => {
      checkInvariants(nonWord, rules.start, [0, 0]);
    }).toThrow(/xqz/u);
    const apart = {
      ...base,
      board: board(rules, [
        { row, col, word: "at" },
        { row: 0, col: 0, word: "at" },
      ]),
    };
    expect(() => {
      checkInvariants(apart, rules.start, [0, 0]);
    }).toThrow(/connected/u);
    const offStart = { ...base, board: board(rules, [{ row: 0, col: 0, word: "at" }]) };
    expect(() => {
      checkInvariants(offStart, rules.start, [0, 0]);
    }).toThrow(/connected/u);
    expect(() => {
      checkInvariants({ ...good, scores: [5, 0] }, rules.start, [0, 0]);
    }).toThrow(/score/u);
    const out = {
      ...good,
      finished: { reason: "out" as const, adjustments: [3, -2], leaver: null },
      scores: [3, -2],
    };
    expect(() => {
      checkInvariants(out, rules.start, [0, 0]);
    }).toThrow(/sum to 0/u);
  });
});

describe.each([...RULESETS.keys()])("random games under the %s ruleset", (id) => {
  it(`conserves tiles, keeps every invariant and replays (${String(GAMES)} games)`, () => {
    const rules = ruleset(id);
    const opts = options(id);
    const limit = words.test.maxActions(opts, 2);
    const ends = new Map<string, number>();
    for (let game = 0; game < GAMES; game += 1) {
      const rng = seededRandom(game);
      const setupDraws = recordRandom(seededRandom(game ^ 0x5bd1e995));
      let state: State = words.setup({ options: opts, seats: 2, rng: setupDraws.rng });
      const log: Entry[] = [];
      const earned = [0, 0];
      expect(conserved(state, rules)).toBe(true);
      for (let step = 0; words.result(state) === null; step += 1) {
        expect(step).toBeLessThan(limit);
        const [seat] = words.toAct(state);
        if (seat === undefined) throw new Error("no seat to act in a game in progress");
        const recording = recordRandom(seededRandom(rng.nextInt(2 ** 32)));
        // Now and then a seat leaves, so every ending is reached.
        const leave = rng.nextInt(400);
        let next: { state: State; record: unknown };
        if (leave === 0) {
          next = words.onResign(state, seat, recording.rng, "resign");
          log.push({ seat, kind: "resign", draws: recording.draws });
        } else if (leave === 1) {
          next = words.onTimeout(state, seat, recording.rng);
          log.push({ seat, kind: "timeout", draws: recording.draws });
        } else {
          const action = words.test.randomAction(state, seat, rng, res);
          expect(isGameError(words.validate(state, seat, action, res))).toBe(false);
          next = words.apply(state, seat, action, recording.rng);
          log.push({ seat, kind: "action", action, draws: recording.draws });
        }
        expect(words.recordSchema.safeParse(next.record).success).toBe(true);
        const record = next.record as PublicRecord;
        if (record.type === "play") earned[record.seat] = (earned[record.seat] ?? 0) + record.score;
        state = next.state;
        try {
          checkInvariants(state, rules.start, earned);
        } catch (error) {
          throw new Error(`${id} game ${String(game)} step ${String(step)}: ${String(error)}`);
        }
        if (!conserved(state, rules))
          throw new Error(`tiles not conserved: ${id} game ${String(game)}`);
        for (const held of state.racks) expect(held.length).toBeLessThanOrEqual(rules.rackSize);
        if (state.finished === null) {
          expect(state.scorelessStreak).toBeLessThan(rules.scorelessTurnLimit);
          // A rack is short only once the bag is empty.
          if (state.bag.length > 0)
            for (const held of state.racks) expect(held).toHaveLength(rules.rackSize);
        }
      }
      const reason = words.result(state)?.endReason ?? "";
      ends.set(reason, (ends.get(reason) ?? 0) + 1);

      // Replay with the recorded draws and no resources reproduces the state (02 §5).
      const draws = replayRandom(setupDraws.draws);
      let replayed = words.setup({ options: opts, seats: 2, rng: draws });
      for (const entry of log) {
        const r = replayRandom(entry.draws);
        replayed =
          entry.kind === "action" && entry.action !== undefined
            ? words.apply(replayed, entry.seat, entry.action, r).state
            : entry.kind === "timeout"
              ? words.onTimeout(replayed, entry.seat, r).state
              : words.onResign(replayed, entry.seat, r, "resign").state;
        expect(r.remaining()).toBe(0);
      }
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(state));
    }
    // Every ending was reached (words §5). (Bingos are too rare for the bot; board.test.ts has them.)
    for (const reason of ["out", "scoreless", "resign", "timeout"]) {
      expect(ends.get(reason) ?? 0, reason).toBeGreaterThan(0);
    }
  }, 600_000);
});
