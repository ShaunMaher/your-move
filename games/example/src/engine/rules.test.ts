/**
 * Rules tables for the example game (docs/spec/02-game-framework.md §7.6): dealing, secret plays,
 * round resolution, elimination, exits, the end of the game and the ranking. Every transition is
 * run with a source that throws if drawn from: only `setup` uses randomness.
 */
import { describe, expect, it } from "vitest";

import { allCards, noRandom, OPTIONS, seeded, state } from "../test-support.js";
import { exampleV1 as game } from "./definition.js";
import type { State } from "./state.js";

const ALL = Array.from({ length: 20 }, (_, i) => i + 1);

function play(s: State, seat: number, card: number): State {
  expect(game.validate(s, seat, { card }, {})).toEqual({ ok: true });
  return game.apply(s, seat, { card }, noRandom).state;
}

describe("setup", () => {
  it("deals every seat a sorted hand from one shuffled deck", () => {
    const s = game.setup({ options: { handSize: 4, lives: 3 }, seats: 3, rng: seeded(1) });
    expect(s.hands.map((hand) => hand.length)).toEqual([4, 4, 4]);
    for (const hand of s.hands) expect(hand).toEqual([...hand].sort((a, b) => a - b));
    expect(s.deck).toHaveLength(8);
    expect(allCards(s)).toEqual(ALL);
    expect(s.lives).toEqual([3, 3, 3]);
    expect(s.points).toEqual([0, 0, 0]);
    expect(s.status).toEqual(["playing", "playing", "playing"]);
    expect(s.pending).toEqual([null, null, null]);
    expect(s.round).toBe(1);
    expect(game.toAct(s)).toEqual([0, 1, 2]);
    expect(game.result(s)).toBeNull();
  });

  it("is deterministic for the same draws and varies with them", () => {
    const deal = (seed: number) => game.setup({ options: OPTIONS, seats: 2, rng: seeded(seed) });
    expect(deal(7)).toEqual(deal(7));
    expect(deal(7)).not.toEqual(deal(8));
  });

  it("refuses a seat count validateStart refuses", () => {
    expect(() =>
      game.setup({ options: { handSize: 6, lives: 1 }, seats: 4, rng: seeded(1) }),
    ).toThrow(/can't deal/u);
  });
});

describe("validate (02 §2.1 rules 3–4)", () => {
  // Seat 1 has played 2; seat 2 is out.
  const s = state({
    hands: [[1, 5, 9], [6, 10], []],
    pending: [null, 2, null],
    status: ["playing", "playing", "out"],
  });

  it.each([
    ["a card in hand", 0, 5, null],
    ["another seat's secret play", 0, 2, "NOT_IN_HAND"],
    ["a card in another hand", 0, 6, "NOT_IN_HAND"],
    ["a card in the deck", 0, 20, "NOT_IN_HAND"],
    ["a second play in one round", 1, 6, "ALREADY_PLAYED"],
    ["a seat that is out", 2, 3, "NOT_PLAYING"],
  ])("%s", (_, seat, card, code) => {
    expect(game.validate(s, seat, { card }, {})).toEqual(code === null ? { ok: true } : { code });
  });

  it("refuses everything once the game is over", () => {
    const over = state({ hands: [[1], [2]], endReason: "last-standing" });
    expect(game.validate(over, 0, { card: 1 }, {})).toEqual({ code: "GAME_OVER" });
  });
});

describe("a secret play", () => {
  const s = state({
    hands: [
      [1, 5, 9],
      [2, 6, 10],
      [3, 7, 11],
    ],
  });
  const { state: next, record } = game.apply(s, 0, { card: 5 }, noRandom);

  it("moves the card from hand to the seat's secret play", () => {
    expect(next.hands[0]).toEqual([1, 9]);
    expect(next.pending).toEqual([5, null, null]);
    expect(s.pending).toEqual([null, null, null]);
  });

  it("takes the seat out of toAct while the others still choose (02 §2.3)", () => {
    expect(game.toAct(next)).toEqual([1, 2]);
    expect(game.seatStatus(next)).toEqual(["playing", "playing", "playing"]);
  });

  it("is recorded without the card (02 §2.1 rule 5)", () => {
    expect(record).toEqual({ kind: "played", seat: 0, round: 1 });
  });
});

describe("resolving a round", () => {
  const s = state({
    hands: [
      [1, 5, 9],
      [2, 6, 10],
      [3, 7, 11],
    ],
  });
  const resolved = play(play(play(s, 0, 9), 1, 2), 2, 7);

  it("scores the highest card and costs the lowest a life", () => {
    expect(resolved.points).toEqual([1, 0, 0]);
    expect(resolved.lives).toEqual([2, 1, 2]);
  });

  it("reveals every play in the last round", () => {
    expect(resolved.lastRound).toEqual({
      round: 1,
      plays: [
        { seat: 0, card: 9 },
        { seat: 1, card: 2 },
        { seat: 2, card: 7 },
      ],
      high: 0,
      low: 1,
      eliminated: null,
    });
    expect(resolved.faceUp).toEqual([9, 2, 7]);
    expect(resolved.pending).toEqual([null, null, null]);
  });

  it("starts the next round with one card drawn by every seat, in seat order", () => {
    // The deck held the unused cards in ascending order: 4, 8, 12, …
    expect(resolved.round).toBe(2);
    expect(resolved.hands).toEqual([
      [1, 4, 5],
      [6, 8, 10],
      [3, 11, 12],
    ]);
    expect(game.toAct(resolved)).toEqual([0, 1, 2]);
    expect(allCards(resolved)).toEqual(ALL);
  });

  it("draws nothing when the deck can't give every seat a card", () => {
    const short = state({
      hands: [
        [1, 5],
        [2, 6],
        [3, 7],
      ],
      deck: [19, 20],
    });
    const next = play(play(play(short, 0, 5), 1, 6), 2, 7);
    expect(next.hands).toEqual([[1], [2], [3]]);
    expect(next.deck).toEqual([19, 20]);
    expect(next.endReason).toBeNull();
  });
});

describe("elimination", () => {
  it("puts a seat that loses its last life out, discarding its hand", () => {
    const s = state({
      hands: [
        [1, 5],
        [2, 6],
        [3, 7],
      ],
      lives: [2, 1, 2],
    });
    const next = play(play(play(s, 0, 5), 1, 2), 2, 7);
    expect(next.status).toEqual(["playing", "out", "playing"]);
    expect(next.lives).toEqual([2, 0, 2]);
    expect(next.outOrder).toEqual([1]);
    expect(next.hands[1]).toEqual([]);
    expect(next.discards).toEqual([6]);
    expect(next.lastRound?.eliminated).toBe(1);
    expect(game.toAct(next)).toEqual([0, 2]);
    expect(game.result(next)).toBeNull();
    expect(allCards(next)).toEqual(ALL);
  });

  it("ends the game when one seat is left standing", () => {
    const s = state({
      hands: [
        [1, 5],
        [2, 6],
      ],
      lives: [1, 2],
    });
    const next = play(play(s, 0, 1), 1, 2);
    expect(next.endReason).toBe("last-standing");
    expect(game.toAct(next)).toEqual([]);
    expect(game.seatStatus(next)).toEqual(["out", "playing"]);
    expect(game.result(next)).toEqual({
      ranking: [
        { seat: 1, rank: 1, score: 1 },
        { seat: 0, rank: 2, score: 0 },
      ],
      endReason: "last-standing",
    });
  });
});

describe("running out of cards", () => {
  it("ends the game when the playing seats' hands are empty", () => {
    const s = state({ hands: [[1], [2]], deck: [] });
    const next = play(play(s, 0, 1), 1, 2);
    expect(next.endReason).toBe("cards-exhausted");
    expect(game.toAct(next)).toEqual([]);
    expect(game.result(next)).toEqual({
      ranking: [
        { seat: 1, rank: 1, score: 1 },
        { seat: 0, rank: 2, score: 0 },
      ],
      endReason: "cards-exhausted",
    });
  });
});

describe("ranking (02 §4: standard competition ranking)", () => {
  it.each([
    {
      name: "lives first, then points, ties sharing a rank (1, 2, 2, 4)",
      lives: [2, 1, 1, 0],
      points: [0, 2, 2, 1],
      outOrder: [3],
      ranks: [
        [0, 1],
        [1, 2],
        [2, 2],
        [3, 4],
      ],
    },
    {
      name: "a tie for first",
      lives: [1, 1],
      points: [3, 3],
      outOrder: [],
      ranks: [
        [0, 1],
        [1, 1],
      ],
    },
    {
      name: "seats that went out later rank higher",
      lives: [0, 1, 0],
      points: [4, 0, 1],
      outOrder: [2, 0],
      ranks: [
        [1, 1],
        [0, 2],
        [2, 3],
      ],
    },
  ])("$name", ({ lives, points, outOrder, ranks }) => {
    const s = state({
      hands: lives.map(() => []),
      lives,
      points,
      outOrder,
      status: lives.map((left) => (left > 0 ? "playing" : "out")),
      endReason: "cards-exhausted",
    });
    expect(game.result(s)?.ranking).toEqual(
      ranks.map(([seat, rank]) => ({ seat, rank, score: points[seat ?? 0] })),
    );
  });
});

describe("leaving the game (02 §4)", () => {
  const s = state({
    hands: [
      [1, 5],
      [2, 6],
      [3, 7],
    ],
  });

  it("discards a resigning seat's hand and secret play; the round goes on", () => {
    const played = play(s, 0, 5);
    const { state: next, record } = game.onResign(played, 0, noRandom, "resign");
    expect(record).toEqual({ kind: "resigned", seat: 0 });
    expect(next.status).toEqual(["out", "playing", "playing"]);
    expect(next.pending).toEqual([null, null, null]);
    expect(next.discards).toEqual([1, 5]);
    expect(next.outOrder).toEqual([0]);
    expect(game.toAct(next)).toEqual([1, 2]);
    expect(next.lastRound).toBeNull();
    expect(allCards(next)).toEqual(ALL);
  });

  it("resolves the round when the only seat still choosing leaves", () => {
    const waiting = play(play(s, 0, 5), 1, 2);
    const next = game.onResign(waiting, 2, noRandom, "resign").state;
    expect(next.lastRound).toEqual({
      round: 1,
      plays: [
        { seat: 0, card: 5 },
        { seat: 1, card: 2 },
      ],
      high: 0,
      low: 1,
      eliminated: null,
    });
    expect(game.toAct(next)).toEqual([0, 1]);
    expect(allCards(next)).toEqual(ALL);
  });

  it("ends a two-seat game: the other seat wins and its secret play stays hidden", () => {
    const two = play(
      state({
        hands: [
          [1, 5],
          [2, 6],
        ],
      }),
      1,
      6,
    );
    const next = game.onResign(two, 0, noRandom, "resign").state;
    expect(next.endReason).toBe("last-standing");
    expect(next.pending).toEqual([null, null]);
    expect(next.lastRound).toBeNull();
    expect(game.result(next)?.ranking).toEqual([
      { seat: 1, rank: 1, score: 0 },
      { seat: 0, rank: 2, score: 0 },
    ]);
    expect(allCards(next)).toEqual(ALL);
  });

  it("records a decline as declined, never as a resignation (02 §2.1 rule 9)", () => {
    const { state: next, record } = game.onResign(s, 1, noRandom, "decline");
    expect(record).toEqual({ kind: "declined", seat: 1 });
    expect(game.describe(record)).toEqual([{ seat: 1 }, " declined the game"]);
    expect(next.status).toEqual(["playing", "out", "playing"]);
  });

  it("puts a seat that timed out out of the game", () => {
    const { state: next, record } = game.onTimeout(s, 2, noRandom);
    expect(record).toEqual({ kind: "timedOut", seat: 2 });
    expect(game.seatStatus(next)).toEqual(["playing", "playing", "out"]);
  });

  it("changes nothing for a seat already out or a finished game", () => {
    const out = game.onResign(s, 2, noRandom, "resign").state;
    expect(game.onResign(out, 2, noRandom, "resign").state).toEqual(out);
    const over = state({ hands: [[1], [2]], endReason: "last-standing" });
    expect(game.onTimeout(over, 0, noRandom).state).toEqual(over);
  });
});
