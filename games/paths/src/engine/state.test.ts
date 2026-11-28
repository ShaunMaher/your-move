/**
 * Transition rules tables (paths §2–§5, §9): the marker phase, drawing, deck exhaustion, the
 * draw-order token, skipping empty hands, leaving, and every end condition with its ranking.
 */
import { shuffle } from "@your-move/sdk";
import { seededRandom } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import {
  at,
  game,
  noRandom,
  OPTIONS,
  out,
  placedFor,
  pos,
  STRAIGHT,
  unplaced,
} from "../test-support.js";
import { faced, leave, placeMarker, placeTile, result, seatStatus, setup, toAct } from "./state.js";
import { TILE_COUNT } from "./tiles.js";

const SAFE = placedFor(STRAIGHT);
/** Joins 0–5 and 7–1 turned once: from (0, 0) seat 0 goes down, seat 1 off the top edge. */
const DROPS_LEFT = { tileId: 3, rotation: 1 };
/** Joins each notch to its neighbour on the same edge: off the board from any edge notch. */
const KILLER = { tileId: 0, rotation: 0 };
/** Joins 0–7: the head-on collision of movement.test.ts. */
const HEAD_ON = placedFor([
  [0, 7],
  [1, 2],
  [3, 4],
  [5, 6],
]);

/** Markers far from the action, one per seat, on distinct notches of the bottom row. */
const away = (c: number): ReturnType<typeof at> => at(5, c, 4);

describe("setup (paths §2)", () => {
  it("shuffles all 35 tiles into the deck and starts the marker phase with seat 0", () => {
    const state = setup({ options: OPTIONS, seats: 3, rng: seededRandom(7) });
    expect([...state.deck].sort((a, b) => a - b)).toEqual(
      Array.from({ length: TILE_COUNT }, (_, id) => id),
    );
    expect(state.deck).not.toEqual([...state.deck].sort((a, b) => a - b));
    expect(state.hands).toEqual([[], [], []]);
    expect(state.markers).toEqual([unplaced, unplaced, unplaced]);
    expect(state.board.flat()).toEqual(Array.from({ length: 36 }, () => null));
    expect(state).toMatchObject({ phase: "markers", turn: 0, moves: 0, tokenHolder: null });
    expect(toAct(state)).toEqual([0]);
    expect(seatStatus(state)).toEqual(["playing", "playing", "playing"]);
    expect(result(state)).toBeNull();
  });
});

describe("the marker phase (paths §2)", () => {
  it("puts the marker on the edge notch and passes to the next player, drawing nothing", () => {
    const state = game({ phase: "markers", markers: [unplaced, unplaced, unplaced], moves: 0 });
    const { state: next, record } = placeMarker(state, 0, 47);
    expect(next.markers[0]).toEqual(at(0, 0, 7));
    expect(next).toMatchObject({ phase: "markers", turn: 1, moves: 1 });
    expect(record).toEqual({
      type: "place-marker",
      seat: 0,
      moves: [],
      eliminated: [],
      collided: [],
      skipped: [],
      edgeNotch: 47,
    });
    expect(state.markers[0]).toEqual(unplaced);
  });

  it("deals a full hand to each player in turn order from the top of the deck once all have placed", () => {
    const state = game({
      phase: "markers",
      markers: [at(0, 0, 0), at(0, 1, 0), unplaced],
      turn: 2,
    });
    const { state: next } = placeMarker(state, 2, 24);
    expect(next.markers[2]).toEqual(at(5, 5, 4));
    expect(next.hands).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ]);
    expect(next.deck).toHaveLength(TILE_COUNT - 9);
    expect(next).toMatchObject({ phase: "tiles", turn: 0 });
  });

  it("deals the hand size chosen, and passes over a seat that left before placing", () => {
    const state = game({
      options: { handSize: 1 },
      phase: "markers",
      markers: [at(0, 0, 0), out(1, "declined"), unplaced],
      turn: 2,
    });
    const { state: next } = placeMarker(state, 2, 24);
    expect(next.hands).toEqual([[0], [], [1]]);
    expect(next.turn).toBe(0);
  });

  it("moves on to the next player without a marker when the one to act declines", () => {
    const state = game({ phase: "markers", markers: [at(0, 0, 0), unplaced, unplaced], turn: 1 });
    const { state: next, record } = leave(state, 1, noRandom, "decline");
    expect(next.markers[1]).toEqual(out(10, "declined"));
    expect(next.turn).toBe(2);
    expect(record).toEqual({
      type: "decline",
      seat: 1,
      moves: [],
      eliminated: [],
      collided: [],
      skipped: [],
    });
  });

  it("starts the tile phase when the last player without a marker leaves", () => {
    const state = game({
      phase: "markers",
      markers: [at(0, 0, 0), at(0, 1, 0), unplaced],
      turn: 2,
    });
    const { state: next } = leave(state, 2, noRandom, "decline");
    expect(next).toMatchObject({ phase: "tiles", turn: 0 });
    expect(next.hands.map((hand) => hand.length)).toEqual([3, 3, 0]);
  });

  it("ends with the last player standing when everyone else leaves, even before any tile", () => {
    const state = game({ phase: "markers", markers: [unplaced, at(0, 1, 0)], turn: 0 });
    const { state: next } = leave(state, 0, noRandom, "resign");
    expect(next).toMatchObject({ endReason: "last-standing", turn: null });
    expect(toAct(next)).toEqual([]);
    expect(result(next)).toEqual({
      ranking: [
        { seat: 1, rank: 1 },
        { seat: 0, rank: 2 },
      ],
      endReason: "last-standing",
    });
  });
});

describe("a tile turn (paths §3)", () => {
  it("places the tile on the square the mover faces, moves the marker and draws one tile", () => {
    const state = game({
      markers: [at(0, 2, 0), away(5)],
      hands: [
        [SAFE.tileId, 1, 2],
        [3, 4, 5],
      ],
    });
    const { state: next, record } = placeTile(state, 0, SAFE, noRandom);
    expect(next.board[0]![2]).toEqual(SAFE);
    expect(next.markers[0]).toEqual(at(1, 2, 0));
    // Hands are kept in ascending order; the deck's front tile here is tile 0.
    expect(state.deck[0]).toBe(0);
    expect(next.hands[0]).toEqual([0, 1, 2]);
    expect(next.deck).toEqual(state.deck.slice(1));
    expect(next).toMatchObject({ turn: 1, moves: 11, tokenHolder: null });
    expect(record).toEqual({
      type: "place-tile",
      seat: 0,
      moves: [{ seat: 0, path: [pos(0, 2, 0), pos(0, 2, 5)] }],
      eliminated: [],
      collided: [],
      skipped: [],
      tileId: SAFE.tileId,
      rotation: SAFE.rotation,
      square: { r: 0, c: 2 },
    });
    expect(state.board[0]![2]).toBeNull();
  });

  it("puts out a mover led off the board: no draw, and its hand goes back into the deck", () => {
    const state = game({
      options: { selfElimination: "allowed" },
      markers: [at(0, 2, 0), away(4), away(5)],
      hands: [
        [KILLER.tileId, 9],
        [3, 4, 5],
        [6, 7, 8],
      ],
    });
    const deckBefore = state.deck.length;
    const { state: next, record } = placeTile(state, 0, KILLER, seededRandom(3));
    expect(next.markers[0]).toEqual(out(10));
    expect(next.hands[0]).toEqual([]);
    expect(next.deck).toHaveLength(deckBefore + 1);
    expect(next.deck).toContain(9);
    expect(record.eliminated).toEqual([0]);
    expect(next.turn).toBe(1);
    expect(seatStatus(next)).toEqual(["out", "playing", "playing"]);
  });

  it("refuses to place for a seat with no marker on the board (the framework never asks)", () => {
    const state = game({ markers: [unplaced, away(5)], hands: [[1], []] });
    expect(() => faced(state, 0)).toThrow(/no marker/u);
  });

  it("is deterministic and never changes its input", () => {
    const state = game({
      options: { selfElimination: "allowed" },
      markers: [at(0, 2, 0), away(4), away(5)],
      hands: [[KILLER.tileId, 9], [3], [6]],
      deck: [],
      tokenHolder: 2,
    });
    const before = JSON.stringify(state);
    const first = placeTile(state, 0, KILLER, seededRandom(11));
    const second = placeTile(state, 0, KILLER, seededRandom(11));
    expect(second).toEqual(first);
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("running out of tiles (paths §4)", () => {
  it("draws nothing from an empty deck, and the mover takes the token if nobody holds it", () => {
    const state = game({
      markers: [at(0, 2, 0), away(5)],
      hands: [[SAFE.tileId, 1], [3]],
      deck: [],
    });
    const { state: next } = placeTile(state, 0, SAFE, noRandom);
    expect(next.hands[0]).toEqual([1]);
    expect(next.tokenHolder).toBe(0);
  });

  it("leaves the token where it is when someone already holds it", () => {
    const state = game({
      markers: [at(0, 2, 0), away(5)],
      hands: [[SAFE.tileId, 1], [3]],
      deck: [],
      tokenHolder: 1,
    });
    expect(placeTile(state, 0, SAFE, noRandom).state.tokenHolder).toBe(1);
  });

  it("deals returned tiles one per pass from the token holder; the token goes to the next one short", () => {
    const hands = [[10], [11, 12], [13], [20, 21, 22]];
    const state = game({
      markers: [away(0), away(1), away(2), away(3)],
      hands,
      deck: [],
      tokenHolder: 2,
    });
    const { state: next, record } = leave(state, 3, seededRandom(5), "resign");
    const dealt = shuffle([20, 21, 22], seededRandom(5));
    // From seat 2: seat 2, (3 is out), seat 0, seat 1; the deck is then empty.
    expect(next.hands).toEqual([
      [10, dealt[1]!].sort((a, b) => a - b),
      [11, 12, dealt[2]!].sort((a, b) => a - b),
      [13, dealt[0]!].sort((a, b) => a - b),
      [],
    ]);
    expect(next.deck).toEqual([]);
    // The last tile went to seat 1; the next short seat after it is seat 2.
    expect(next.tokenHolder).toBe(2);
    expect(next.turn).toBe(0);
    expect(next.markers[3]).toEqual(out(10, "resigned"));
    expect(record).toEqual({
      type: "resign",
      seat: 3,
      moves: [],
      eliminated: [],
      collided: [],
      skipped: [],
    });
  });

  it("keeps dealing round the table until every hand is full, then clears the token", () => {
    const state = game({
      markers: [away(0), away(1), away(2), away(3)],
      hands: [[10, 11], [12, 13, 14], [15], [20, 21, 22]],
      deck: [],
      tokenHolder: 2,
    });
    const { state: next } = leave(state, 3, seededRandom(5), "resign");
    expect(next.hands.map((hand) => hand.length)).toEqual([3, 3, 3, 0]);
    expect(next.deck).toEqual([]);
    expect(next.tokenHolder).toBeNull();
  });

  it("shuffles returned tiles into the deck when nobody is short, and leaves them there", () => {
    const state = game({
      markers: [away(0), away(1), away(2)],
      hands: [
        [10, 11, 12],
        [13, 14, 15],
        [20, 21],
      ],
      deck: [30, 31],
    });
    const { state: next } = leave(state, 2, seededRandom(9), "timeout");
    expect([...next.deck].sort((a, b) => a - b)).toEqual([20, 21, 30, 31]);
    expect(next.hands.map((hand) => hand.length)).toEqual([3, 3, 0]);
    expect(next.tokenHolder).toBeNull();
    expect(next.markers[2]).toEqual(out(10, "timed_out"));
  });

  it("passes the token on when its holder leaves: to the next player after them who is short", () => {
    const state = game({
      markers: [away(0), away(1), away(2), away(3)],
      hands: [[10], [], [12, 13, 14], [15]],
      deck: [],
      tokenHolder: 1,
    });
    expect(leave(state, 1, noRandom, "resign").state.tokenHolder).toBe(3);
  });

  it("clears the token when its holder leaves and nobody else is short", () => {
    const state = game({
      markers: [away(0), away(1), away(2)],
      hands: [[10, 11, 12], [], [13, 14, 15]],
      deck: [],
      tokenHolder: 1,
    });
    expect(leave(state, 1, noRandom, "resign").state.tokenHolder).toBeNull();
  });

  it("passes the token on when its holder is eliminated by a tile", () => {
    const state = game({
      markers: [at(0, 0, 0), at(0, 0, 7), away(5)],
      hands: [[DROPS_LEFT.tileId, 10], [], [12]],
      deck: [],
      tokenHolder: 1,
    });
    const { state: next, record } = placeTile(state, 0, DROPS_LEFT, noRandom);
    expect(record.eliminated).toEqual([1]);
    // Seat 1 held the token; seat 2 is the next player after it who is short.
    expect(next.tokenHolder).toBe(2);
    expect(next.turn).toBe(2);
  });
});

describe("skipping empty hands (paths §3 step 7)", () => {
  it("skips survivors with no tiles, lists them in the record and never puts them in toAct", () => {
    const state = game({
      markers: [at(0, 2, 0), away(4), away(5)],
      hands: [[SAFE.tileId, 1], [], [2]],
      deck: [],
    });
    const { state: next, record } = placeTile(state, 0, SAFE, noRandom);
    expect(record.skipped).toEqual([1]);
    expect(toAct(next)).toEqual([2]);
  });

  it("comes back round to the mover when nobody else holds a tile", () => {
    const state = game({
      markers: [at(0, 2, 0), away(4), away(5)],
      hands: [[SAFE.tileId, 1], [], []],
      deck: [],
    });
    const { state: next, record } = placeTile(state, 0, SAFE, noRandom);
    expect(record.skipped).toEqual([1, 2]);
    expect(toAct(next)).toEqual([0]);
  });

  it("skips after a resignation too, when the returned tiles go to someone else", () => {
    const state = game({
      options: { handSize: 1 },
      markers: [away(0), away(1), away(2), away(3)],
      hands: [[10], [], [11], []],
      deck: [],
      tokenHolder: 3,
    });
    const { state: next, record } = leave(state, 0, noRandom, "resign");
    expect(next.hands).toEqual([[], [], [11], [10]]);
    expect(record.skipped).toEqual([1]);
    expect(toAct(next)).toEqual([2]);
    expect(next.tokenHolder).toBe(1);
  });

  it("keeps the turn with the player to act when someone else resigns", () => {
    const state = game({
      markers: [away(0), away(1), away(2)],
      hands: [[10], [11], []],
      deck: [],
      turn: 1,
    });
    const { state: next, record } = leave(state, 0, seededRandom(1), "resign");
    expect(next.turn).toBe(1);
    expect(record.skipped).toEqual([]);
  });
});

describe("end of game and ranking (paths §5)", () => {
  it("ends with the last player standing when a tile puts the other one out", () => {
    const state = game({
      markers: [at(0, 0, 0), at(0, 0, 7)],
      hands: [[DROPS_LEFT.tileId], [10]],
    });
    const { state: next } = placeTile(state, 0, DROPS_LEFT, seededRandom(2));
    expect(next).toMatchObject({ endReason: "last-standing", turn: null });
    expect(result(next)).toEqual({
      ranking: [
        { seat: 0, rank: 1 },
        { seat: 1, rank: 2 },
      ],
      endReason: "last-standing",
    });
  });

  it("gives a simultaneous wipe-out a shared first place", () => {
    const state = game({
      markers: [at(1, 0, 0), at(1, 0, 7)],
      board: [{ r: 0, c: 0, placed: SAFE }],
      hands: [[HEAD_ON.tileId], [10]],
    });
    const { state: next, record } = placeTile(state, 0, HEAD_ON, seededRandom(2));
    expect(record.collided).toEqual([[0, 1]]);
    expect(result(next)).toEqual({
      ranking: [
        { seat: 0, rank: 1 },
        { seat: 1, rank: 1 },
      ],
      endReason: "wipe-out",
    });
    expect(seatStatus(next)).toEqual(["out", "out"]);
  });

  it("ranks a collision's players together, below the survivor", () => {
    const state = game({
      markers: [at(1, 0, 0), at(1, 0, 7), away(5)],
      board: [{ r: 0, c: 0, placed: SAFE }],
      hands: [[HEAD_ON.tileId], [10], [11]],
    });
    const { state: next } = placeTile(state, 0, HEAD_ON, seededRandom(2));
    expect(result(next)).toEqual({
      ranking: [
        { seat: 2, rank: 1 },
        { seat: 0, rank: 2 },
        { seat: 1, rank: 2 },
      ],
      endReason: "last-standing",
    });
  });

  it("ends with a shared win when no surviving player holds a tile (board full)", () => {
    const state = game({ markers: [at(0, 2, 0), away(5)], hands: [[SAFE.tileId], []], deck: [] });
    const { state: next, record } = placeTile(state, 0, SAFE, noRandom);
    expect(record.skipped).toEqual([]);
    expect(result(next)).toEqual({
      ranking: [
        { seat: 0, rank: 1 },
        { seat: 1, rank: 1 },
      ],
      endReason: "board-full",
    });
  });

  it("ranks by elimination order, the most recently out higher, ties sharing a rank", () => {
    const state = {
      ...game({ markers: [away(0), out(3), out(5), out(5, "timed_out")], moves: 8 }),
      endReason: "last-standing" as const,
      turn: null,
    };
    expect(result(state)?.ranking).toEqual([
      { seat: 0, rank: 1 },
      { seat: 2, rank: 2 },
      { seat: 3, rank: 2 },
      { seat: 1, rank: 4 },
    ]);
  });

  it("ends with the last player standing when the other one resigns in the tile phase", () => {
    const state = game({ markers: [away(0), away(1)], hands: [[10], [11]], turn: 1 });
    const { state: next } = leave(state, 1, seededRandom(4), "resign");
    expect(next.endReason).toBe("last-standing");
    expect(result(next)?.ranking[0]).toEqual({ seat: 0, rank: 1 });
  });

  it("leaves a seat that is already out, or a finished game, as it is", () => {
    const state = game({ markers: [away(0), out(2), away(2)], hands: [[10], [], [11]] });
    const { state: next, record } = leave(state, 1, noRandom, "resign");
    expect(next).toEqual(state);
    expect(record).toEqual({
      type: "resign",
      seat: 1,
      moves: [],
      eliminated: [],
      collided: [],
      skipped: [],
    });
    const over = { ...state, endReason: "board-full" as const, turn: null };
    expect(leave(over, 0, noRandom, "timeout").state).toEqual(over);
  });
});
