import { describe, expect, it } from "vitest";

import { facing, game, out, placedFor, STRAIGHT, unplaced } from "../test-support.js";
import { describe as describeRecord, summary, view } from "./present.js";
import { viewSchema, type PublicRecord } from "./schemas.js";

const SAFE = placedFor(STRAIGHT);

describe("view (paths §7)", () => {
  const state = game({
    markers: [facing(1, 2, 0), out(4, "resigned"), facing(5, 5, 4)],
    board: [{ r: 0, c: 2, placed: SAFE }],
    hands: [[1, 2], [], [3, 4, 5]],
    deck: [6, 7],
    tokenHolder: 0,
  });

  it("shows a seat the board, every marker, the counts and its own hand only", () => {
    const seen = view(state, 0);
    expect(viewSchema.parse(seen)).toEqual(seen);
    expect(seen).toEqual({
      boardSize: 6,
      phase: "tiles",
      board: state.board,
      markers: state.markers,
      toAct: [0],
      deckCount: 2,
      handCounts: [2, 0, 3],
      yourHand: [1, 2],
      hands: null,
      tokenHolder: 0,
      endReason: null,
    });
    expect(view(state, 2).yourHand).toEqual([3, 4, 5]);
  });

  it("shows the public viewer no hand", () => {
    expect(view(state, null).yourHand).toBeNull();
    expect(view(state, null).hands).toBeNull();
  });

  it("reveals every remaining hand, never the deck order, once the game is over", () => {
    const over = { ...state, turn: null, endReason: "board-full" as const };
    const seen = view(over, null);
    expect(seen.hands).toEqual([[1, 2], [], [3, 4, 5]]);
    expect(seen.toAct).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain('deck":');
  });

  it("returns copies: changing a view never changes the state", () => {
    const seen = view(state, 0);
    seen.yourHand?.push(30);
    seen.markers[0]!.pos = null;
    expect(state.hands[0]).toEqual([1, 2]);
    expect(state.markers[0]).toEqual(facing(1, 2, 0));
  });
});

describe("summary (paths §7)", () => {
  const state = game({ markers: [facing(1, 2, 0), out(4), facing(5, 5, 4)], turn: 2 });

  it("counts the players left and says whose turn it is", () => {
    expect(summary(state, 2)).toEqual({ headline: ["2 left of 3 · ", "your turn"] });
    expect(summary(state, 0)).toEqual({ headline: ["2 left of 3 · ", { seat: 2 }, " to play"] });
    expect(summary(state, null)).toEqual({ headline: ["2 left of 3 · ", { seat: 2 }, " to play"] });
  });

  it("names the winner, or a shared win, once over", () => {
    const won = { ...state, markers: [facing(1, 2, 0), out(4), out(6)], turn: null };
    expect(summary({ ...won, endReason: "last-standing" }, 1)).toEqual({
      headline: [{ seat: 0 }, " won"],
    });
    expect(summary({ ...state, turn: null, endReason: "board-full" }, 1)).toEqual({
      headline: ["Shared win"],
    });
    expect(summary({ ...state, turn: null, endReason: "wipe-out" }, null)).toEqual({
      headline: ["Shared win"],
    });
  });

  it("works in the marker phase too", () => {
    const markers = game({ phase: "markers", markers: [unplaced, unplaced] });
    expect(summary(markers, 0)).toEqual({ headline: ["2 left of 2 · ", "your turn"] });
  });
});

describe("describe (paths §7)", () => {
  const base = { seat: 0, moves: [], eliminated: [], collided: [], skipped: [] };
  const tile = (fields: Partial<PublicRecord>): PublicRecord =>
    ({
      type: "place-tile",
      ...base,
      tileId: 1,
      rotation: 0,
      square: { r: 0, c: 0 },
      ...fields,
    }) as PublicRecord;

  it.each<[string, PublicRecord, unknown[]]>([
    [
      "a marker",
      { type: "place-marker", ...base, edgeNotch: 3 },
      [{ seat: 0 }, " placed their marker"],
    ],
    ["a quiet tile", tile({}), [{ seat: 0 }, " placed a tile"]],
    [
      "a collision",
      tile({ eliminated: [2, 3], collided: [[2, 3]] }),
      [{ seat: 0 }, " placed a tile — ", { seat: 2 }, " and ", { seat: 3 }, " crashed!"],
    ],
    [
      "a marker run off the board",
      tile({ eliminated: [1] }),
      [{ seat: 0 }, " placed a tile — ", { seat: 1 }, " ran off the board"],
    ],
    [
      "a collision and three run off the board",
      tile({ eliminated: [0, 1, 2, 3, 4], collided: [[1, 4]] }),
      [
        { seat: 0 },
        " placed a tile — ",
        { seat: 1 },
        " and ",
        { seat: 4 },
        " crashed! ",
        { seat: 0 },
        ", ",
        { seat: 2 },
        " and ",
        { seat: 3 },
        " ran off the board",
      ],
    ],
    ["a resignation", { type: "resign", ...base }, [{ seat: 0 }, " resigned"]],
    ["a decline", { type: "decline", ...base }, [{ seat: 0 }, " declined the game"]],
    ["a timeout", { type: "timeout", ...base }, [{ seat: 0 }, " ran out of time"]],
  ])("tells of %s", (_name, record, text) => {
    expect(describeRecord(record)).toEqual(text);
  });

  it("never says a decline was a resignation (02 §2.1 rule 9)", () => {
    const text = describeRecord({ type: "decline", ...base });
    expect(text.filter((part) => typeof part === "string").join("")).not.toMatch(/resign/u);
  });
});
