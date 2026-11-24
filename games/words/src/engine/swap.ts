/**
 * The bag and the `swapOrder` behaviour variants (docs/spec/games/words.md §3.2).
 *
 * The bag is an array whose **last** element is its top: draws take tiles from the end. The swap
 * functions assume the action has already been validated (words §10.3: the tiles are in the rack,
 * and the bag holds at least `swapMinBag` tiles); a violated precondition is a bug and throws.
 */
import { shuffle, type RandomSource } from "@your-move/sdk";

import type { SwapOrder } from "./rulesets/schema.js";

/** A rack and a bag after tiles moved between them. */
export interface RackAndBag {
  readonly rack: string[];
  readonly bag: string[];
}

/** Draws up to `count` tiles from the top of the bag (fewer if the bag runs out). */
export function draw(bag: readonly string[], count: number): { drawn: string[]; bag: string[] } {
  const keep = Math.max(0, bag.length - count);
  return { drawn: bag.slice(keep).reverse(), bag: bag.slice(0, keep) };
}

/** The rack without one copy of each of `tiles`; throws if a tile isn't there. */
export function removeFromRack(rack: readonly string[], tiles: readonly string[]): string[] {
  const left = [...rack];
  for (const tile of tiles) {
    const index = left.indexOf(tile);
    if (index === -1) throw new Error("swap precondition: tile not in rack");
    left.splice(index, 1);
  }
  return left;
}

/**
 * Swaps `tiles` from the rack with tiles from the bag, in the ruleset's order:
 *
 * - `drawThenReturn`: draw the replacements from the top of the bag, put the chosen tiles into
 *   the bag, then re-shuffle the whole bag, so the player can't redraw their own tiles;
 * - `returnThenDraw`: put the chosen tiles into the bag, re-shuffle, then draw, so the player may
 *   redraw some of them.
 */
export function swapTiles(
  rack: readonly string[],
  bag: readonly string[],
  tiles: readonly string[],
  order: SwapOrder,
  rng: RandomSource,
): RackAndBag {
  if (tiles.length === 0) throw new Error("swap precondition: no tiles chosen");
  const kept = removeFromRack(rack, tiles);
  if (order === "drawThenReturn") {
    if (bag.length < tiles.length) throw new Error("swap precondition: too few tiles in the bag");
    const drawn = draw(bag, tiles.length);
    return { rack: [...kept, ...drawn.drawn], bag: shuffle([...drawn.bag, ...tiles], rng) };
  }
  const drawn = draw(shuffle([...bag, ...tiles], rng), tiles.length);
  return { rack: [...kept, ...drawn.drawn], bag: drawn.bag };
}
