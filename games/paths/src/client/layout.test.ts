import { describe, expect, it } from "vitest";

import { edgeNotch, NOTCHES, TILES, across } from "../engine/index.js";
import {
  edgeName,
  edgeNotchesOf,
  endOf,
  hopsOf,
  isEdge,
  notchName,
  notchOffset,
  pairD,
  placeName,
  placedPairs,
  pointOf,
  SQUARE,
  traceD,
  walk,
} from "./layout.js";

describe("notch points (paths §1)", () => {
  it("put each notch a third of the way along its edge, clockwise from the top left", () => {
    expect(Array.from({ length: NOTCHES }, (_, n) => notchOffset(n))).toEqual([
      { x: 32, y: 0 },
      { x: 64, y: 0 },
      { x: 96, y: 32 },
      { x: 96, y: 64 },
      { x: 64, y: 96 },
      { x: 32, y: 96 },
      { x: 0, y: 64 },
      { x: 0, y: 32 },
    ]);
    expect(() => notchOffset(8)).toThrow(RangeError);
  });

  it("give a notch and the notch across it the same point on the board", () => {
    for (let r = 0; r < 5; r += 1) {
      for (let c = 0; c < 5; c += 1) {
        for (let n = 0; n < NOTCHES; n += 1) {
          const far = across(6, { r, c, n });
          if (far !== null) expect(pointOf(far)).toEqual(pointOf({ r, c, n }));
        }
      }
    }
  });

  it("lie on the board's border for every edge notch", () => {
    for (let e = 0; e < 48; e += 1) {
      const { x, y } = pointOf(edgeNotch(6, e));
      expect([0, 6 * SQUARE].some((edge) => edge === x || edge === y)).toBe(true);
    }
  });
});

describe("notch names (paths §8)", () => {
  it("read as the diagram does", () => {
    expect(notchName(0)).toBe("Top edge, left notch");
    expect(notchName(1)).toBe("Top edge, right notch");
    expect(notchName(2)).toBe("Right edge, upper notch");
    expect(notchName(3)).toBe("Right edge, lower notch");
    expect(notchName(4)).toBe("Bottom edge, right notch");
    expect(notchName(5)).toBe("Bottom edge, left notch");
    expect(notchName(6)).toBe("Left edge, lower notch");
    expect(notchName(7)).toBe("Left edge, upper notch");
    expect(edgeName(9)).toBe(" edge");
    expect(placeName(9)).toBe("");
  });

  it("find the edge notches of a square: 4 in a corner, 2 on a side, none inside", () => {
    expect(edgeNotchesOf(6, 0, 0)).toEqual([0, 1, 6, 7]);
    expect(edgeNotchesOf(6, 0, 3)).toEqual([0, 1]);
    expect(edgeNotchesOf(6, 3, 5)).toEqual([2, 3]);
    expect(edgeNotchesOf(6, 5, 2)).toEqual([4, 5]);
    expect(edgeNotchesOf(6, 3, 3)).toEqual([]);
    expect(isEdge(6, { r: 0, c: 0, n: 0 })).toBe(true);
    expect(isEdge(6, { r: 0, c: 0, n: 3 })).toBe(false);
  });
});

describe("paths and traces", () => {
  it("reads the four paths of every tile at every rotation from the engine's partners", () => {
    for (const tile of TILES) {
      for (let rotation = 0; rotation < 4; rotation += 1) {
        const pairs = placedPairs(tile.id, rotation);
        expect(pairs).toHaveLength(4);
        expect(new Set(pairs.flat()).size).toBe(8);
      }
    }
  });

  it("draws a path as a curve through the square's centre", () => {
    expect(pairD([0, 5])).toBe("M32 0 Q48 48 32 96");
  });

  it("turns a movement trace into hops: the first enters by the start notch, the rest by the far side", () => {
    // Start at notch 0 of (0, 2); the tile there leaves by 5; the next tile, (1, 2), is entered
    // by notch 0 (5 XOR 5) and left by 3.
    const path = [
      { r: 0, c: 2, n: 0 },
      { r: 0, c: 2, n: 5 },
      { r: 1, c: 2, n: 3 },
    ];
    expect(hopsOf(path)).toEqual([
      { r: 0, c: 2, from: 0, to: 5 },
      { r: 1, c: 2, from: 0, to: 3 },
    ]);
    expect(hopsOf([])).toEqual([]);
    expect(traceD(hopsOf(path))).toBe("M224 0 Q240 48 224 96 Q240 144 288 160");
    expect(endOf(path)).toEqual(pointOf({ r: 1, c: 2, n: 3 }));
    expect(endOf([])).toBeNull();
  });

  it("walks along the curve and ends exactly on the last notch", () => {
    const hops = hopsOf([
      { r: 0, c: 2, n: 0 },
      { r: 0, c: 2, n: 5 },
      { r: 1, c: 2, n: 3 },
    ]);
    const points = walk(hops, 4);
    expect(points).toHaveLength(8);
    expect(points[3]).toEqual({ x: 224, y: 96 });
    expect(points[7]).toEqual({ x: 288, y: 160 });
    expect(points[0]?.y).toBeGreaterThan(0);
  });
});
