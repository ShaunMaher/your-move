import { describe, expect, it } from "vitest";

import {
  allMatchings,
  canonical,
  compareMatchings,
  normalise,
  partner,
  rotatePairs,
  ROTATIONS,
  TILE_COUNT,
  TILES,
  type Pair,
} from "./tiles.js";

const key = (pairs: readonly Pair[]): string => JSON.stringify(normalise(pairs));

describe("the tile set (paths §1)", () => {
  it("starts from all 105 perfect matchings of the 8 notches", () => {
    const matchings = allMatchings();
    expect(matchings).toHaveLength(105);
    expect(new Set(matchings.map(key)).size).toBe(105);
    for (const matching of matchings) {
      expect(matching.flat().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    }
  });

  it("has exactly 35 tiles, numbered 0–34, none a rotation of another", () => {
    expect(TILES).toHaveLength(TILE_COUNT);
    expect(TILES.map((tile) => tile.id)).toEqual(Array.from({ length: 35 }, (_, id) => id));
    const rotations = new Map<string, number>();
    for (const tile of TILES) {
      for (let k = 0; k < ROTATIONS; k += 1) {
        const other = rotations.get(key(rotatePairs(tile.pairs, k)));
        expect(other === undefined || other === tile.id).toBe(true);
        rotations.set(key(rotatePairs(tile.pairs, k)), tile.id);
      }
    }
    // Every matching is some rotation of exactly one tile.
    expect(rotations.size).toBe(105);
  });

  it("stores each tile in canonical form, and numbers the tiles in lexicographic order of it", () => {
    for (const tile of TILES) {
      expect(tile.pairs).toEqual(canonical(tile.pairs));
      expect(tile.pairs).toEqual(normalise(tile.pairs));
    }
    for (let id = 1; id < TILES.length; id += 1) {
      expect(compareMatchings(TILES[id - 1]!.pairs, TILES[id]!.pairs)).toBeLessThan(0);
    }
  });

  it("pins every id to its canonical form (ids are part of the rules version)", () => {
    const written = TILES.map((tile) =>
      tile.pairs.map(([a, b]) => `${String(a)}${String(b)}`).join(" "),
    );
    expect(written).toEqual([
      "01 23 45 67",
      "01 23 46 57",
      "01 23 47 56",
      "01 24 36 57",
      "01 24 37 56",
      "01 25 36 47",
      "01 25 37 46",
      "01 26 34 57",
      "01 26 35 47",
      "01 26 37 45",
      "01 27 34 56",
      "01 27 35 46",
      "01 27 36 45",
      "02 13 46 57",
      "02 13 47 56",
      "02 14 36 57",
      "02 14 37 56",
      "02 15 36 47",
      "02 15 37 46",
      "02 16 34 57",
      "02 16 35 47",
      "02 17 34 56",
      "02 17 35 46",
      "03 12 47 56",
      "03 14 26 57",
      "03 14 27 56",
      "03 15 26 47",
      "03 16 25 47",
      "04 12 36 57",
      "04 12 37 56",
      "04 13 26 57",
      "04 15 26 37",
      "04 15 27 36",
      "05 14 27 36",
      "07 12 34 56",
    ]);
  });

  it("counts the tiles with each symmetry as Burnside predicts: (105 + 5 + 25 + 5) / 4", () => {
    const fixedBy = (k: number): number =>
      allMatchings().filter((m) => key(rotatePairs(m, k)) === key(m)).length;
    expect([0, 1, 2, 3].map(fixedBy)).toEqual([105, 5, 25, 5]);
  });
});

describe("rotation (paths §1)", () => {
  it("turns a path {a, b} into {a + 2k, b + 2k} mod 8", () => {
    expect(rotatePairs([[0, 1]], 1)).toEqual([[2, 3]]);
    expect(rotatePairs([[6, 7]], 1)).toEqual([[0, 1]]);
    expect(rotatePairs([[0, 5]], 3)).toEqual([[3, 6]]);
  });

  it("gives every tile's partner at every rotation and notch, as an involution without fixed points", () => {
    for (const tile of TILES) {
      for (let k = 0; k < ROTATIONS; k += 1) {
        const joined = rotatePairs(tile.pairs, k);
        for (let n = 0; n < 8; n += 1) {
          const p = partner(tile.id, k, n);
          expect(p).not.toBe(n);
          expect(partner(tile.id, k, p)).toBe(n);
          expect(joined).toContainEqual(n < p ? [n, p] : [p, n]);
          // Rotating the tile by k turns notch n - 2k of the canonical form into notch n.
          expect(p).toBe((partner(tile.id, 0, (n - 2 * k + 8) % 8) + 2 * k) % 8);
        }
      }
    }
  });
});
