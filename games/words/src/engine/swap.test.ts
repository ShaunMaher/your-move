import { seededRandom } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { SWAP_ORDERS } from "./rulesets/schema.js";
import { draw, removeFromRack, swapTiles } from "./swap.js";

const sorted = (tiles: readonly string[]): string[] => [...tiles].sort();

describe("draw", () => {
  it.each([
    { bag: ["a", "b", "c"], count: 2, drawn: ["c", "b"], left: ["a"] },
    { bag: ["a", "b", "c"], count: 0, drawn: [], left: ["a", "b", "c"] },
    { bag: ["a"], count: 3, drawn: ["a"], left: [] },
    { bag: [], count: 2, drawn: [], left: [] },
  ])("draws $count from the top (end) of $bag", ({ bag, count, drawn, left }) => {
    expect(draw(bag, count)).toStrictEqual({ drawn, bag: left });
  });
});

describe("removeFromRack", () => {
  it("removes one copy per chosen tile and keeps the order of the rest", () => {
    expect(removeFromRack(["a", "b", "a", "?"], ["a", "?"])).toStrictEqual(["b", "a"]);
  });

  it("throws if a chosen tile isn't in the rack (validate runs first)", () => {
    expect(() => removeFromRack(["a"], ["a", "a"])).toThrow(/not in rack/u);
  });
});

describe("swapTiles (words §3.2)", () => {
  const rack = ["a", "b", "c", "d", "e", "f", "g"];
  const bag = ["n", "o", "p", "q", "r", "s", "t", "u", "v", "w"];

  it.each(SWAP_ORDERS)("%s conserves tiles and keeps the rack size", (order) => {
    for (let seed = 0; seed < 200; seed += 1) {
      const chosen = rack.slice(0, 1 + (seed % rack.length));
      const after = swapTiles(rack, bag, chosen, order, seededRandom(seed));
      expect(after.rack).toHaveLength(rack.length);
      expect(after.bag).toHaveLength(bag.length);
      expect(sorted([...after.rack, ...after.bag])).toStrictEqual(sorted([...rack, ...bag]));
      for (const tile of rack.slice(chosen.length)) expect(after.rack).toContain(tile);
    }
  });

  it.each(SWAP_ORDERS)("%s is deterministic for the same random values", (order) => {
    const one = swapTiles(rack, bag, ["a", "b"], order, seededRandom(7));
    const two = swapTiles(rack, bag, ["a", "b"], order, seededRandom(7));
    expect(one).toStrictEqual(two);
  });

  it("drawThenReturn draws the replacements from the top before returning the chosen tiles", () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const after = swapTiles(rack, bag, ["a", "b", "c"], "drawThenReturn", seededRandom(seed));
      expect(after.rack).toStrictEqual(["d", "e", "f", "g", "w", "v", "u"]);
      expect(after.bag).toEqual(expect.arrayContaining(["a", "b", "c"]));
    }
  });

  it("drawThenReturn re-shuffles the whole bag, not only the returned tiles", () => {
    const orders = new Set<string>();
    for (let seed = 0; seed < 50; seed += 1) {
      orders.add(swapTiles(rack, bag, ["a"], "drawThenReturn", seededRandom(seed)).bag.join(""));
    }
    expect(orders.size).toBeGreaterThan(40);
  });

  it("returnThenDraw lets the player redraw their own tiles, and drawThenReturn never does", () => {
    let redrew = 0;
    for (let seed = 0; seed < 500; seed += 1) {
      const chosen = ["a", "b", "c", "d", "e", "f", "g"];
      const rtd = swapTiles(rack, bag, chosen, "returnThenDraw", seededRandom(seed));
      if (rtd.rack.some((tile) => chosen.includes(tile))) redrew += 1;
      const dtr = swapTiles(rack, bag, chosen, "drawThenReturn", seededRandom(seed));
      expect(dtr.rack.some((tile) => chosen.includes(tile))).toBe(false);
    }
    expect(redrew).toBeGreaterThan(0);
  });

  it("returnThenDraw works when the bag holds fewer tiles than are swapped", () => {
    const after = swapTiles(rack, ["z"], ["a", "b"], "returnThenDraw", seededRandom(1));
    expect(after.rack).toHaveLength(7);
    expect(after.bag).toHaveLength(1);
  });

  it.each([
    ["no tiles chosen", rack, bag, [], "drawThenReturn"],
    ["a tile not in the rack", rack, bag, ["z"], "returnThenDraw"],
    ["drawThenReturn with too few tiles in the bag", rack, ["z"], ["a", "b"], "drawThenReturn"],
  ] as const)("throws on a violated precondition: %s", (_name, r, b, tiles, order) => {
    expect(() => swapTiles(r, b, tiles, order, seededRandom(1))).toThrow(/precondition/u);
  });
});
