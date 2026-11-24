/**
 * The game's rules over whole transitions (words §2–§6): dealing, plays and drawing, both swap
 * orders, passes, the scoreless streak, every ending with its final scoring, and the result.
 */
import { seededRandom } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { board, conserved, options, play, rack, ruleset, state } from "../test-support.js";
import { wordsV1 as words } from "./definition.js";
import type { Ruleset } from "./rulesets/schema.js";
import { allTiles, rackOf, rackValue, setup, type State } from "./state.js";

const CLASSIC = ruleset("classic");
const CASUAL = ruleset("casual");
const [SR, SC] = CLASSIC.start;
const CAT = { row: SR, col: SC - 1, word: "cat" };

/**
 * A word's score worked out by hand from the ruleset's own premium picture and tile table
 * (words §4), independently of the engine: the word is laid across from (row, col), and its new
 * tiles are at the indices in `fresh`; only they count their premiums.
 */
function byHand(rules: Ruleset, word: string, row: number, col: number, fresh: number[]): number {
  let sum = 0;
  let times = 1;
  word.split("").forEach((tile, i) => {
    const code = fresh.includes(i) ? rules.premiums[row]?.[col + i] : ".";
    const points = rules.tiles[tile]?.points ?? Number.NaN;
    sum += points * (code === "d" ? 2 : code === "t" ? 3 : 1);
    times *= code === "D" ? 2 : code === "T" ? 3 : 1;
  });
  return sum * times;
}

/** A source that must never be drawn from: proves a transition uses no randomness. */
const noRandom = {
  nextInt(): number {
    throw new Error("drew a random value");
  },
};

describe("setup (words §2)", () => {
  it.each([
    ["classic", CLASSIC],
    ["casual", CASUAL],
  ])("deals rackSize tiles to every seat from a shuffled %s bag", (id, rules) => {
    const s = setup({ options: options(id), seats: 2, rng: seededRandom(1) });
    expect(s.racks.map((r) => r.length)).toEqual([rules.rackSize, rules.rackSize]);
    expect(s.bag).toHaveLength(allTiles(rules).length - 2 * rules.rackSize);
    expect(conserved(s, rules)).toBe(true);
    expect(s.turn).toBe(0);
    expect(s.scores).toEqual([0, 0]);
    expect(s.board.flat().every((square) => square === null)).toBe(true);
    expect(words.toAct(s)).toEqual([0]);
    expect(words.seatStatus(s)).toEqual(["playing", "playing"]);
    expect(words.result(s)).toBeNull();
  });

  it("shuffles with the random source: different seeds, different deals; same seed, same deal", () => {
    const deal = (seed: number): State =>
      setup({ options: options(), seats: 2, rng: seededRandom(seed) });
    expect(deal(1)).toEqual(deal(1));
    expect(deal(1).bag).not.toEqual(deal(2).bag);
  });

  it("refuses more seats than the tiles can fill (validateStart refuses them first)", () => {
    expect(() => setup({ options: options(), seats: 15, rng: seededRandom(1) })).toThrow(
      RangeError,
    );
    expect(words.validateStart(options(), 15)).toEqual({
      code: "NOT_ENOUGH_TILES",
      detail: { needed: 105, tiles: 100 },
    });
    expect(words.validateStart(options(), 2)).toEqual({ ok: true });
  });

  it("refuses an unknown ruleset version (options are resolved first)", () => {
    expect(() =>
      setup({ options: { ...options(), rulesetVersion: 99 }, seats: 2, rng: seededRandom(1) }),
    ).toThrow(RangeError);
  });
});

describe("playing tiles (words §3.1, §4)", () => {
  it("places the tiles, scores the play, draws back up and passes the turn, with no randomness", () => {
    const s = state({ racks: [rack("sabcdeq"), rack("eeeeeee")], board: board(CLASSIC, [CAT]) });
    const action = play([{ row: SR, col: SC + 2, word: "s" }]);
    // C A T already there, S new: only the S's square can carry a premium.
    const expected = { score: byHand(CLASSIC, "cats", SR, SC - 1, [3]) };
    const { state: next, record } = words.apply(s, 0, action, noRandom);
    expect(next.board[SR]?.[SC + 2]).toEqual({ tile: "s", letter: "s" });
    expect(next.racks[0]).toHaveLength(CLASSIC.rackSize);
    expect(next.racks[0]?.slice(0, 6)).toEqual(rack("abcdeq"));
    expect(next.bag).toHaveLength(s.bag.length - 1);
    expect(next.scores).toEqual([expected.score, 0]);
    expect(next.turn).toBe(1);
    expect(next.scorelessStreak).toBe(0);
    expect(conserved(next, CLASSIC)).toBe(true);
    expect(record).toEqual({
      seat: 0,
      type: "play",
      placements: [{ row: SR, col: SC + 2, tile: "s", letter: "s" }],
      words: [{ word: "cats", score: expected.score }],
      score: expected.score,
      bingo: false,
    });
    expect(next.lastMove).toEqual(record);
  });

  it("draws from the top of the bag, and only as many as it holds", () => {
    const s = state({ racks: [rack("sabcdeq"), rack("eeeeeee")], board: board(CLASSIC, [CAT]) });
    const action = play([{ row: SR, col: SC + 2, word: "s" }]);
    const top = words.apply({ ...s, bag: ["x", "y"] }, 0, action, noRandom).state;
    expect(top.racks[0]).toEqual([...rack("abcdeq"), "y"]);
    expect(top.bag).toEqual(["x"]);
    // Two tiles played, one left in the bag: the rack ends one short.
    const two = state({ racks: [rack("oxabcde"), rack("eeeeeee")], board: board(CLASSIC, [CAT]) });
    const short = words.apply(
      { ...two, bag: ["y"] },
      0,
      play([{ row: SR + 1, col: SC, word: "ox" }]),
      noRandom,
    );
    expect(short.state.racks[0]).toEqual([...rack("abcde"), "y"]);
    expect(short.state.bag).toEqual([]);
    expect(short.state.finished).toBeNull();
  });

  it("records the placements in board order, whatever order they were sent in", () => {
    const s = state({ racks: [rack("oxabcde"), rack("eeeeeee")], board: board(CLASSIC, [CAT]) });
    const sent = play([{ row: SR + 1, col: SC, word: "ox" }]);
    const reversed = { ...sent, placements: [...sent.placements].reverse() };
    const a = words.apply(s, 0, sent, noRandom);
    const b = words.apply(s, 0, reversed, noRandom);
    expect(b).toEqual(a);
    expect(a.record.type === "play" && a.record.placements.map((p) => p.col)).toEqual([SC, SC + 1]);
  });

  it("writes a blank's letter on the board and records it", () => {
    const s = state({ racks: [rack("?abcdeq"), rack("eeeeeee")], board: board(CLASSIC, [CAT]) });
    const { state: next, record } = words.apply(
      s,
      0,
      play([{ row: SR, col: SC + 2, word: "S" }]),
      noRandom,
    );
    expect(next.board[SR]?.[SC + 2]).toEqual({ tile: "?", letter: "s" });
    expect(record).toMatchObject({
      placements: [{ row: SR, col: SC + 2, tile: "?", letter: "s" }],
    });
  });

  it("counts a play that scores nothing (only blanks) as scoreless", () => {
    const s = state({ racks: [rack("??abcde"), rack("eeeeeee")], scorelessStreak: 2 });
    const opening = play([{ row: SR, col: SC, word: "AT" }]);
    const { state: next } = words.apply(s, 0, opening, noRandom);
    expect(next.scores[0]).toBe(0);
    expect(next.scorelessStreak).toBe(3);
  });

  it("refuses to apply a play that isn't legal (validate runs first)", () => {
    const s = state({ racks: [rack("abcdefg"), rack("eeeeeee")] });
    expect(() => words.apply(s, 0, play([{ row: 0, col: 0, word: "ab" }]), noRandom)).toThrow(
      RangeError,
    );
  });

  it("scores with the game's ruleset premiums: the start square's on the opening play", () => {
    const s = state({ racks: [rack("atbcdeq"), rack("eeeeeee")] });
    const action = play([{ row: SR, col: SC, word: "at" }]);
    const { record } = words.apply(s, 0, action, noRandom);
    // Classic's start square is a double word (words §8.3).
    expect(CLASSIC.premiums[SR]?.[SC]).toBe("D");
    expect(record.score).toBe(byHand(CLASSIC, "at", SR, SC, [0, 1]));
  });

  it("scores the casual opening, whose start square has no premium (words §8.3)", () => {
    const s = state({ rulesetId: "casual", racks: [rack("atbcdeq"), rack("eeeeeee")] });
    const { record } = words.apply(s, 0, play([{ row: SR, col: SC, word: "at" }]), noRandom);
    expect(CASUAL.premiums[SR]?.[SC]).toBe(".");
    expect(record.score).toBe(byHand(CASUAL, "at", SR, SC, [0, 1]));
  });
});

describe("swapping (words §3.2)", () => {
  /** A state whose bag holds only `bag` (top last), with seat 0 holding `own`. */
  const swapState = (rulesetId: string, own: string, bag: string): State => {
    const s = state({ rulesetId, racks: [rack(own), rack("eeeeeee")] });
    return { ...s, bag: rack(bag) };
  };

  it("drawThenReturn (classic): draws first, so the player can't redraw their own tiles", () => {
    expect(CLASSIC.swapOrder).toBe("drawThenReturn");
    for (let seed = 0; seed < 50; seed += 1) {
      const s = swapState("classic", "qabcdef", "zzzzzzz".replaceAll("z", "o"));
      const { state: next, record } = words.apply(
        s,
        0,
        { type: "swap", tiles: ["q"] },
        seededRandom(seed),
      );
      expect(next.racks[0]).toEqual([...rack("abcdef"), "o"]);
      expect([...next.bag].sort()).toEqual(rack("ooooooq").sort());
      expect(record).toEqual({ seat: 0, type: "swap", score: 0, bingo: false, swapCount: 1 });
    }
  });

  it("returnThenDraw (casual): returns first, so the player may redraw their own tiles", () => {
    expect(CASUAL.swapOrder).toBe("returnThenDraw");
    const redrawn = new Set<string>();
    for (let seed = 0; seed < 50; seed += 1) {
      const s = swapState("casual", "qabcdef", "ooooooo");
      const { state: next } = words.apply(s, 0, { type: "swap", tiles: ["q"] }, seededRandom(seed));
      const drawn = next.racks[0]?.[6] ?? "";
      redrawn.add(drawn);
      expect([...(next.racks[0] ?? []), ...next.bag].sort()).toEqual(rack("abcdefoooooooq").sort());
    }
    expect(redrawn).toEqual(new Set(["o", "q"]));
  });

  it("adds to the scoreless streak and passes the turn", () => {
    const s = swapState("classic", "qabcdef", "ooooooo");
    const { state: next } = words.apply(s, 0, { type: "swap", tiles: ["q", "a"] }, seededRandom(1));
    expect(next.scorelessStreak).toBe(1);
    expect(next.turn).toBe(1);
    expect(next.scores).toEqual([0, 0]);
  });
});

describe("passing and the scoreless streak (words §3.3, §5 rule 2, §6)", () => {
  it("passes score nothing, add to the streak, and a scoring play resets it", () => {
    let s = state({ racks: [rack("sabcdeq"), rack("eeeeeee")], board: board(CLASSIC, [CAT]) });
    s = words.apply(s, 0, { type: "pass" }, noRandom).state;
    s = words.apply(s, 1, { type: "pass" }, noRandom).state;
    expect(s.scorelessStreak).toBe(2);
    expect(s.lastMove).toEqual({ seat: 1, type: "pass", score: 0, bingo: false });
    s = words.apply(s, 0, play([{ row: SR, col: SC + 2, word: "s" }]), noRandom).state;
    expect(s.scorelessStreak).toBe(0);
  });

  it("ends the game at scorelessTurnLimit: everyone loses their own rack's value", () => {
    let s = state({ racks: [rack("qabcdef"), rack("zeeeeee")], scores: [30, 40] });
    for (let turn = 0; turn < CLASSIC.scorelessTurnLimit; turn += 1) {
      expect(words.result(s)).toBeNull();
      s = words.apply(s, turn % 2, { type: "pass" }, noRandom).state;
    }
    const lost = [rackValue(CLASSIC, rack("qabcdef")), rackValue(CLASSIC, rack("zeeeeee"))];
    expect(lost).toEqual([10 + 1 + 3 + 3 + 2 + 1 + 4, 10 + 6]);
    expect(s.finished).toEqual({
      reason: "scoreless",
      adjustments: [-lost[0]!, -lost[1]!],
      leaver: null,
    });
    expect(s.scores).toEqual([30 - lost[0]!, 40 - lost[1]!]);
    expect(words.toAct(s)).toEqual([]);
    expect(words.seatStatus(s)).toEqual(["playing", "playing"]);
    expect(words.result(s)).toEqual({
      ranking: [
        { seat: 1, rank: 1, score: 24 },
        { seat: 0, rank: 2, score: 6 },
      ],
      endReason: "scoreless",
    });
  });

  it("takes the limit from the ruleset, and counts swaps and zero-point plays", () => {
    let s = state({ racks: [rack("??abcde"), rack("eeeeeee")] });
    s = words.apply(s, 0, play([{ row: SR, col: SC, word: "AT" }]), noRandom).state;
    s = words.apply(s, 1, { type: "swap", tiles: ["e"] }, seededRandom(1)).state;
    expect(s.scorelessStreak).toBe(2);
    expect(s.finished).toBeNull();
    const nearlyOver = { ...s, scorelessStreak: CLASSIC.scorelessTurnLimit - 1 };
    expect(words.apply(nearlyOver, 0, { type: "pass" }, noRandom).state.finished?.reason).toBe(
      "scoreless",
    );
  });
});

describe("going out (words §5 rule 1, §6)", () => {
  it("ends when the bag is empty and a player plays their last tile", () => {
    const s = {
      ...state({ racks: [rack("s"), rack("qz")], board: board(CLASSIC, [CAT]), scores: [50, 60] }),
      bag: [],
    };
    const { state: next } = words.apply(
      s,
      0,
      play([{ row: SR, col: SC + 2, word: "s" }]),
      noRandom,
    );
    const played = byHand(CLASSIC, "cats", SR, SC - 1, [3]);
    expect(next.finished).toEqual({ reason: "out", adjustments: [20, -20], leaver: null });
    expect(next.scores).toEqual([50 + played + 20, 40]);
    expect(words.result(next)?.endReason).toBe("out");
    expect(words.result(next)?.ranking[0]).toEqual({ seat: 0, rank: 1, score: 50 + played + 20 });
  });

  it("doesn't end while the bag still holds tiles, nor when the rack still holds some", () => {
    const base = state({ racks: [rack("sa"), rack("qz")], board: board(CLASSIC, [CAT]) });
    const action = play([{ row: SR, col: SC + 2, word: "s" }]);
    expect(words.apply(base, 0, action, noRandom).state.finished).toBeNull();
    expect(words.apply({ ...base, bag: [] }, 0, action, noRandom).state.finished).toBeNull();
  });
});

describe("leaving (words §3.4, §5 rules 3–4, §6, §10.6)", () => {
  const s = state({ racks: [rack("qabcdef"), rack("zeeeeee")], scores: [90, 10] });

  it.each([
    ["resign", "resign"],
    ["decline", "decline"],
  ] as const)(
    "onResign(%s) ends the game with scores frozen; the leaver ranks last",
    (reason, type) => {
      const { state: next, record } = words.onResign(s, 0, noRandom, reason);
      expect(record).toEqual({ seat: 0, type, score: 0, bingo: false });
      expect(next.finished).toEqual({ reason: type, adjustments: [0, 0], leaver: 0 });
      expect(next.scores).toEqual([90, 10]);
      expect(words.seatStatus(next)).toEqual(["out", "playing"]);
      expect(words.toAct(next)).toEqual([]);
      expect(words.result(next)).toEqual({
        ranking: [
          { seat: 1, rank: 1, score: 10 },
          { seat: 0, rank: 2, score: 90 },
        ],
        endReason: type,
      });
    },
  );

  it("onTimeout ends the game like a resignation, recorded as a timeout", () => {
    const { state: next, record } = words.onTimeout(s, 1, noRandom);
    expect(record).toEqual({ seat: 1, type: "timeout", score: 0, bingo: false });
    expect(next.finished?.reason).toBe("timeout");
    expect(words.result(next)?.ranking).toEqual([
      { seat: 0, rank: 1, score: 90 },
      { seat: 1, rank: 2, score: 10 },
    ]);
  });

  it("throws once the game is over: the framework never calls it then (02 §2.1 rule 3)", () => {
    const over = words.onResign(s, 0, noRandom, "resign").state;
    expect(() => words.onTimeout(over, 1, noRandom)).toThrow(RangeError);
    expect(() => words.onResign(over, 1, noRandom, "resign")).toThrow(RangeError);
  });

  it("throws for a game of more than two seats, whose resignation isn't specified (§3.4)", () => {
    const three = state({ racks: [rack("qabcdef"), rack("zeeeeee"), rack("ooooooo")] });
    expect(() => words.onResign(three, 2, noRandom, "decline")).toThrow(RangeError);
    expect(() => words.onTimeout(three, 0, noRandom)).toThrow(RangeError);
  });
});

describe("the result (words §6, §10.6)", () => {
  it("ranks equal scores together: a draw", () => {
    const s = state({
      racks: [rack("a"), rack("a")],
      scores: [25, 25],
      finished: { reason: "scoreless", adjustments: [0, 0], leaver: null },
    });
    expect(words.result(s)?.ranking).toEqual([
      { seat: 0, rank: 1, score: 25 },
      { seat: 1, rank: 1, score: 25 },
    ]);
  });
});

describe("engine invariants", () => {
  it("treats a seat that doesn't exist as a bug", () => {
    const s = state({ racks: [rack("a"), rack("b")] });
    expect(rackOf(s, 1)).toEqual(["b"]);
    expect(() => rackOf(s, 2)).toThrow(RangeError);
    expect(() => rackOf(s, -1)).toThrow(RangeError);
  });
});
