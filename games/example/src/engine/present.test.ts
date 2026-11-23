/**
 * Views, summaries, history text and previews (docs/spec/02-game-framework.md §2 "Presenting",
 * §2.1 rules 4, 5 and 9).
 */
import { describe as group, expect, it } from "vitest";

import { noRandom, state } from "../test-support.js";
import { exampleV1 as game } from "./definition.js";
import { previewSchema, recordSchema, viewSchema, type PublicRecord } from "./schemas.js";

// Seat 1 has played 2; seat 2 is out.
const s = state({
  hands: [[1, 5, 9], [6, 10], []],
  pending: [null, 2, null],
  status: ["playing", "playing", "out"],
  lives: [2, 1, 0],
  points: [1, 0, 2],
  outOrder: [2],
  deck: [20, 19, 18],
});

group("view (02 §2.1 rule 4)", () => {
  it("shows a seat its own hand and nobody else's", () => {
    const view = viewSchema.parse(game.view(s, 0));
    expect(view.you).toBe(0);
    expect(view.yourPlay).toBeNull();
    expect(view.seats.map((seat) => seat.hand)).toEqual([[1, 5, 9], null, null]);
    expect(view.seats.map((seat) => seat.handCount)).toEqual([3, 2, 0]);
    expect(view.deckCount).toBe(3);
  });

  it("shows whether a seat has played, never which card, except to that seat", () => {
    const other = game.view(s, 0);
    expect(other.seats.map((seat) => seat.played)).toEqual([false, true, false]);
    const own = game.view(s, 1);
    expect(own.yourPlay).toBe(2);
    expect(own.seats[1]?.hand).toEqual([6, 10]);
  });

  it("shows the public viewer no hand at all", () => {
    const view = viewSchema.parse(game.view(s, null));
    expect(view.you).toBeNull();
    expect(view.yourPlay).toBeNull();
    expect(view.seats.every((seat) => seat.hand === null)).toBe(true);
  });

  it("shows public counts, lives, points and statuses to everyone", () => {
    const visible = game
      .view(s, null)
      .seats.map(({ status, lives, points, handCount, played }) => ({
        status,
        lives,
        points,
        handCount,
        played,
      }));
    expect(visible).toEqual([
      { status: "playing", lives: 2, points: 1, handCount: 3, played: false },
      { status: "playing", lives: 1, points: 0, handCount: 2, played: true },
      { status: "out", lives: 0, points: 2, handCount: 0, played: false },
    ]);
  });

  it("reveals the last round once resolved, and every hand once the game is over", () => {
    const round = {
      round: 1,
      plays: [
        { seat: 0, card: 3 },
        { seat: 1, card: 4 },
      ],
      high: 1,
      low: 0,
      eliminated: null,
    };
    const over = state({ hands: [[1, 5], [6]], lastRound: round, endReason: "cards-exhausted" });
    const view = viewSchema.parse(game.view(over, null));
    expect(view.lastRound).toEqual(round);
    expect(view.endReason).toBe("cards-exhausted");
    expect(view.seats.map((seat) => seat.hand)).toEqual([[1, 5], [6]]);
  });

  it("is a copy: changing it never changes the state", () => {
    const view = game.view(s, 0);
    view.seats[0]?.hand?.push(20);
    expect(s.hands[0]).toEqual([1, 5, 9]);
  });
});

group("summary", () => {
  it.each([
    [0, ["Round 1: ", "your turn"]],
    [1, ["Round 1: ", "waiting for 1 player"]],
    [2, ["Round 1: ", "waiting for 1 player"]],
    [null, ["Round 1: ", "waiting for 1 player"]],
  ])("for viewer %s", (viewer, headline) => {
    expect(game.summary(s, viewer)).toEqual({ headline, scores: [1, 0, 2] });
  });

  it("counts every seat still choosing", () => {
    const fresh = state({ hands: [[1], [2], [3]] });
    expect(game.summary(fresh, null).headline).toEqual(["Round 1: ", "waiting for 3 players"]);
  });

  it("names the winner, or says the cards ran out", () => {
    const won = state({ hands: [[], [1]], status: ["out", "playing"], endReason: "last-standing" });
    expect(game.summary(won, 0).headline).toEqual([{ seat: 1 }, " won"]);
    const exhausted = state({ hands: [[], []], endReason: "cards-exhausted" });
    expect(game.summary(exhausted, null).headline).toEqual(["Game over: out of cards"]);
  });
});

group("describe (02 §5)", () => {
  it.each<[PublicRecord, unknown[]]>([
    [{ kind: "played", seat: 0, round: 3 }, [{ seat: 0 }, " played a card in round 3"]],
    [{ kind: "resigned", seat: 1 }, [{ seat: 1 }, " resigned"]],
    [{ kind: "declined", seat: 2 }, [{ seat: 2 }, " declined the game"]],
    [{ kind: "timedOut", seat: 3 }, [{ seat: 3 }, " ran out of time"]],
  ])("%o", (record, text) => {
    expect(recordSchema.parse(record)).toEqual(record);
    expect(game.describe(record)).toEqual(text);
  });

  it("is built from records that never name a card", () => {
    const { record } = game.apply(s, 0, { card: 9 }, noRandom);
    expect(record).toEqual({ kind: "played", seat: 0, round: 1 });
  });
});

group("preview", () => {
  it("shows what would be left in hand", () => {
    const answer = game.preview?.(s, 0, { card: 5 }, {});
    expect(previewSchema.parse(answer)).toEqual({ handAfter: [1, 9] });
  });

  it("returns the same error as validate", () => {
    for (const [seat, card] of [
      [0, 2],
      [1, 6],
      [2, 1],
    ] as const) {
      expect(game.preview?.(s, seat, { card }, {})).toEqual(game.validate(s, seat, { card }, {}));
    }
  });
});
