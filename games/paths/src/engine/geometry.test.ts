import { describe, expect, it } from "vitest";

import { across, edgeNotch, edgeNotchCount, onBoard, samePosition } from "./geometry.js";

const SIZE = 6;

describe("notch adjacency (paths §1)", () => {
  it("joins notch n to notch n XOR 5 of the neighbour across that edge", () => {
    expect(across(SIZE, { r: 2, c: 3, n: 0 })).toEqual({ r: 1, c: 3, n: 5 });
    expect(across(SIZE, { r: 2, c: 3, n: 1 })).toEqual({ r: 1, c: 3, n: 4 });
    expect(across(SIZE, { r: 2, c: 3, n: 2 })).toEqual({ r: 2, c: 4, n: 7 });
    expect(across(SIZE, { r: 2, c: 3, n: 3 })).toEqual({ r: 2, c: 4, n: 6 });
    expect(across(SIZE, { r: 2, c: 3, n: 4 })).toEqual({ r: 3, c: 3, n: 1 });
    expect(across(SIZE, { r: 2, c: 3, n: 5 })).toEqual({ r: 3, c: 3, n: 0 });
    expect(across(SIZE, { r: 2, c: 3, n: 6 })).toEqual({ r: 2, c: 2, n: 3 });
    expect(across(SIZE, { r: 2, c: 3, n: 7 })).toEqual({ r: 2, c: 2, n: 2 });
  });

  it("is symmetric, and a notch has no neighbour exactly when it is on the board's edge", () => {
    let edges = 0;
    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c < SIZE; c += 1) {
        for (let n = 0; n < 8; n += 1) {
          const far = across(SIZE, { r, c, n });
          if (far === null) {
            edges += 1;
            continue;
          }
          expect(onBoard(SIZE, far.r, far.c)).toBe(true);
          expect(far.n).toBe(n ^ 5);
          expect(across(SIZE, far)).toEqual({ r, c, n });
        }
      }
    }
    expect(edges).toBe(edgeNotchCount(SIZE));
  });
});

describe("the edge-notch index (paths §1)", () => {
  it("numbers the edge notches clockwise from the top-left corner", () => {
    expect(edgeNotch(SIZE, 0)).toEqual({ r: 0, c: 0, n: 0 });
    expect(edgeNotch(SIZE, 1)).toEqual({ r: 0, c: 0, n: 1 });
    expect(edgeNotch(SIZE, 11)).toEqual({ r: 0, c: 5, n: 1 });
    expect(edgeNotch(SIZE, 12)).toEqual({ r: 0, c: 5, n: 2 });
    expect(edgeNotch(SIZE, 23)).toEqual({ r: 5, c: 5, n: 3 });
    expect(edgeNotch(SIZE, 24)).toEqual({ r: 5, c: 5, n: 4 });
    expect(edgeNotch(SIZE, 35)).toEqual({ r: 5, c: 0, n: 5 });
    expect(edgeNotch(SIZE, 36)).toEqual({ r: 5, c: 0, n: 6 });
    expect(edgeNotch(SIZE, 47)).toEqual({ r: 0, c: 0, n: 7 });
  });

  it("follows the table's formula for every index, each an edge notch, all of them distinct", () => {
    const B = SIZE;
    const seen = new Set<string>();
    for (let e = 0; e < 8 * B; e += 1) {
      const side = Math.floor(e / (2 * B));
      const offset = e - 2 * B * side;
      const k = Math.floor(offset / 2);
      const j = offset % 2;
      const expected = [
        { r: 0, c: k, n: j },
        { r: k, c: B - 1, n: 2 + j },
        { r: B - 1, c: B - 1 - k, n: 4 + j },
        { r: B - 1 - k, c: 0, n: 6 + j },
      ][side];
      const pos = edgeNotch(B, e);
      expect(pos).toEqual(expected);
      expect(across(B, pos)).toBeNull();
      seen.add(JSON.stringify(pos));
    }
    expect(seen.size).toBe(8 * B);
  });

  it("throws for an index off the board, which validate never passes on", () => {
    expect(() => edgeNotch(SIZE, -1)).toThrow(RangeError);
    expect(() => edgeNotch(SIZE, 48)).toThrow(RangeError);
    expect(() => edgeNotch(SIZE, 1.5)).toThrow(RangeError);
  });
});

describe("positions", () => {
  it("are the same only for the same square and notch", () => {
    expect(samePosition({ r: 1, c: 2, n: 3 }, { r: 1, c: 2, n: 3 })).toBe(true);
    expect(samePosition({ r: 1, c: 2, n: 3 }, { r: 1, c: 2, n: 4 })).toBe(false);
    expect(samePosition({ r: 1, c: 2, n: 3 }, { r: 2, c: 2, n: 3 })).toBe(false);
    expect(samePosition({ r: 1, c: 2, n: 3 }, { r: 1, c: 3, n: 3 })).toBe(false);
  });
});
