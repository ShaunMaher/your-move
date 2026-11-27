/**
 * How much work the no-play search does on realistic boards with the real built-in word list
 * (words §10.8), and so where its step limit (`HINT_MAX_STEPS`) sits. The boards come from seeded
 * bot games under every bundled ruleset: mid-game (after 12 plays) and late-game (the bag
 * empty). On each, the seat to act's own rack is searched with its blanks taken out and with one
 * and two blanks put in, then racks that rarely have a play (Q, QV, VVWW, CVVJQX) for the
 * "none" case. Steps are deterministic, so the test checks them; time is only measured.
 *
 * Measured on a development laptop (2026-11-27, Node 26, AMD Ryzen 7 PRO 7840HS), 9–10 games per
 * ruleset, 18 boards each, with the list as the client holds it: one sorted string searched in
 * place (`createWordList`, words §9.4), nothing built.
 *
 * | Case                                    | Answer      | Max steps | Max time |
 * |-----------------------------------------|-------------|-----------|----------|
 * | the player's rack, no blank             | some        |     2,100 |   2.6 ms |
 * | the player's rack, one blank            | some        |     2,700 |   3.2 ms |
 * | the player's rack, two blanks           | some        |     3,100 |   7.2 ms |
 * | awkward racks                           | some / none |     4,100 |   2.5 ms |
 * | full walk, no blank (no word accepted)  | none        |    32,000 |   7.6 ms |
 * | full walk, one blank (median 65,000)    | none        |   242,000 |    60 ms |
 * | full walk, two blanks (median 316,000)  | none        |   803,000 |   195 ms |
 *
 * About 0.24 µs a step here (an array of the words was 0.09 µs, but costs several megabytes more
 * on a phone); a slow phone is assumed 5–10× slower, so the limit (150,000 steps) is about 36 ms
 * here and a few hundred milliseconds there, in slices. The "full walk" rows search with a word
 * list that accepts no word, so nothing is found and every prefix the rack can make on squares
 * without cross-words is tried: a stand-in for proving "none" on a busy board. With no blank it
 * always fits under the limit; with one blank it usually does; with two it mostly doesn't, and
 * the hint stays silent (`unknown`), which is the sound answer. Trying two-tile plays everywhere
 * before longer ones (`SHORT_PLAY`) is what keeps "some" small: depth-first alone took up to
 * 44,000 steps with two blanks. Re-measure when the search or the list changes; never raise the
 * limit so far that a slow phone works for more than a few hundred milliseconds in total.
 */
import type { Resources } from "@your-move/sdk";
import { seededRandom } from "@your-move/testkit";
import { beforeAll, describe, expect, it } from "vitest";

import { options, realDictionary, realWordList, wordList } from "../test-support.js";
import type { Board } from "./board.js";
import { wordsV1 as words } from "./definition.js";
import { HINT_MAX_STEPS, searchPlays, type Lexicon } from "./moves.js";
import { RULESETS, latestRuleset } from "./rulesets/index.js";
import type { State } from "./state.js";

const GAMES = 10;
const MID_GAME_PLAYS = 12;
const AWKWARD = ["q", "qv", "vvww", "cvvjqx"];

interface Measured {
  readonly kind: string;
  readonly steps: number;
  readonly ms: number;
}

function measure(state: State, board: Board, tiles: readonly string[], lexicon: Lexicon): Measured {
  const ruleset = latestRuleset(state.options.rulesetId);
  if (ruleset === undefined) throw new Error("no ruleset");
  const search = searchPlays({
    ruleset,
    board,
    rack: tiles,
    lexicon,
    maxSteps: Number.MAX_SAFE_INTEGER,
  });
  const started = performance.now();
  const outcome = search.advance(Number.MAX_SAFE_INTEGER);
  return {
    kind: outcome?.kind ?? "unfinished",
    steps: search.steps,
    ms: performance.now() - started,
  };
}

/** The rack with its blanks swapped for `e`, then its first `blanks` tiles made blanks. */
function withBlanks(tiles: readonly string[], blanks: number): string[] {
  return tiles.map((tile, i) => (i < blanks ? "?" : tile === "?" ? "e" : tile));
}

/** Mid-game and late-game states of seeded bot games under a ruleset. */
function boards(id: string, res: Resources): State[] {
  const found: State[] = [];
  for (let game = 0; game < GAMES; game += 1) {
    const rng = seededRandom(500 + game);
    let state: State = words.setup({ options: options(id), seats: 2, rng: seededRandom(game) });
    let plays = 0;
    let mid = false;
    for (let turn = 0; words.result(state) === null && turn < 400; turn += 1) {
      if (!mid && plays >= MID_GAME_PLAYS) {
        found.push(state);
        mid = true;
      }
      if (state.bag.length === 0) {
        found.push(state);
        break;
      }
      const [seat = 0] = words.toAct(state);
      const action = words.test.randomAction(state, seat, rng, res);
      if (action.type === "play") plays += 1;
      state = words.apply(state, seat, action, seededRandom(turn)).state;
    }
  }
  return found;
}

describe.each([...RULESETS.keys()])("the no-play search under the %s ruleset", (id) => {
  let res: Resources;
  let lexicon: Lexicon;
  let states: State[];
  beforeAll(async () => {
    res = (await realDictionary()).resources;
    lexicon = wordList(await realWordList());
    states = boards(id, res);
  });

  const rackOf = (state: State): string[] => state.racks[state.turn] ?? [];

  it("reaches mid-game and late-game boards", () => {
    expect(states.length).toBeGreaterThanOrEqual(GAMES * 2 - 2);
  });

  it.each([0, 1, 2])(
    "answers for the player's own rack with %i blanks well inside the limit",
    (blanks) => {
      for (const state of states) {
        const result = measure(state, state.board, withBlanks(rackOf(state), blanks), lexicon);
        expect(result.kind).not.toBe("unknown");
        expect(result.steps).toBeLessThan(HINT_MAX_STEPS / 10);
      }
    },
  );

  it("proves there is no play for awkward racks, well inside the limit", () => {
    let none = 0;
    for (const state of states) {
      for (const tiles of AWKWARD) {
        const result = measure(state, state.board, tiles.split(""), lexicon);
        if (result.kind === "none") none += 1;
        expect(result.steps).toBeLessThan(HINT_MAX_STEPS / 10);
      }
    }
    expect(none).toBeGreaterThan(states.length);
  });

  it("walks every prefix of a rack with no blank inside the limit", () => {
    const refusing: Lexicon = { has: () => false, follows: (prefix) => lexicon.follows(prefix) };
    for (const state of states) {
      const result = measure(state, state.board, withBlanks(rackOf(state), 0), refusing);
      expect(result.kind).toBe("none");
      expect(result.steps).toBeLessThan(HINT_MAX_STEPS);
    }
  });
});
