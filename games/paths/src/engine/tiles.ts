/**
 * The tile set (docs/spec/games/paths.md §1): every way of joining a tile's 8 notches into 4
 * paths, counting rotations of a tile as the same tile. There are 105 such matchings and 35
 * distinct tiles.
 *
 * A matching is written as its 4 pairs, each pair ascending and the pairs sorted. A tile's
 * canonical form is the lexicographically smallest of its 4 rotations in that notation, and the
 * tiles are numbered 0–34 in lexicographic order of canonical form. A tile's `rotation` is
 * relative to its canonical form. Ids are part of the rules version.
 */
import { at } from "./at.js";
import { NOTCHES } from "./geometry.js";

/** One path of a tile: the two notches it joins, ascending. */
export type Pair = readonly [number, number];

/** A tile: its id and the 4 paths of its canonical form. */
export interface Tile {
  readonly id: number;
  readonly pairs: readonly Pair[];
}

/** The number of quarter turns a tile can be placed at. */
export const ROTATIONS = 4;

/** Every perfect matching of the notches `0..NOTCHES-1`, as normalised pairs. */
export function allMatchings(): Pair[][] {
  const results: Pair[][] = [];
  const extend = (free: readonly number[], pairs: readonly Pair[]): void => {
    const [first, ...rest] = free;
    if (first === undefined) {
      results.push([...pairs]);
      return;
    }
    for (const second of rest) {
      extend(
        rest.filter((n) => n !== second),
        [...pairs, [first, second]],
      );
    }
  };
  extend(
    Array.from({ length: NOTCHES }, (_, n) => n),
    [],
  );
  return results;
}

/** Writes pairs in the notation of §1: each pair ascending, the pairs sorted. */
export function normalise(pairs: readonly Pair[]): Pair[] {
  return pairs
    .map(([a, b]): Pair => (a < b ? [a, b] : [b, a]))
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

/** Turns a matching `k` quarter turns clockwise: `{a, b}` becomes `{a + 2k, b + 2k} mod 8`. */
export function rotatePairs(pairs: readonly Pair[], k: number): Pair[] {
  const turn = (n: number): number => (n + 2 * k) % NOTCHES;
  return normalise(pairs.map(([a, b]): Pair => [turn(a), turn(b)]));
}

/** Compares two normalised matchings lexicographically (as their flattened notch lists). */
export function compareMatchings(a: readonly Pair[], b: readonly Pair[]): number {
  const x = a.flat();
  const y = b.flat();
  for (let i = 0; i < x.length; i += 1) {
    const difference = at(x, i) - at(y, i);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The canonical form of a matching: the smallest of its 4 rotations. */
export function canonical(pairs: readonly Pair[]): Pair[] {
  let best = normalise(pairs);
  for (let k = 1; k < ROTATIONS; k += 1) {
    const rotated = rotatePairs(pairs, k);
    if (compareMatchings(rotated, best) < 0) best = rotated;
  }
  return best;
}

/** A stable text key for a normalised matching. */
function keyOf(pairs: readonly Pair[]): string {
  return pairs.map(([a, b]) => `${String(a)}${String(b)}`).join(" ");
}

/** Generates the tile set: the distinct canonical forms, in lexicographic order. */
function generateTiles(): readonly Tile[] {
  const forms = new Map<string, Pair[]>();
  for (const matching of allMatchings()) {
    const form = canonical(matching);
    forms.set(keyOf(form), form);
  }
  return Object.freeze(
    [...forms.values()]
      .sort(compareMatchings)
      .map((pairs, id): Tile => Object.freeze({ id, pairs: Object.freeze(pairs) })),
  );
}

/** The 35 tiles, indexed by id. */
export const TILES: readonly Tile[] = generateTiles();

/** How many tiles there are (and how many the deck holds). */
export const TILE_COUNT = 35;

/**
 * For each tile and rotation, the partner of each notch: `PARTNERS[id][rotation][n]` is the notch
 * that notch `n` is joined to on that tile placed at that rotation.
 */
const PARTNERS: readonly (readonly (readonly number[])[])[] = TILES.map((tile) =>
  Array.from({ length: ROTATIONS }, (_, k) => {
    const partner = Array.from({ length: NOTCHES }, () => 0);
    for (const [a, b] of rotatePairs(tile.pairs, k)) {
      partner[a] = b;
      partner[b] = a;
    }
    return partner;
  }),
);

/** The notch that notch `n` leads to on tile `tileId` placed at `rotation`. */
export function partner(tileId: number, rotation: number, n: number): number {
  return at(at(at(PARTNERS, tileId), rotation), n);
}
