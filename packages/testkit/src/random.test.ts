import { describe, expect, it } from "vitest";

import { canonical, isPlainJson, sameJson } from "./canonical.js";
import { scriptedRandom, seededRandom } from "./random.js";

describe("seededRandom", () => {
  it("is deterministic per seed and stays in range", () => {
    const draw = (seed: number) => {
      const rng = seededRandom(seed);
      return Array.from({ length: 50 }, () => rng.nextInt(7));
    };
    expect(draw(3)).toEqual(draw(3));
    expect(draw(3)).not.toEqual(draw(4));
    expect(draw(3).every((value) => value >= 0 && value < 7)).toBe(true);
  });

  it("rejects draws above the largest multiple of the range, so values stay unbiased", () => {
    // 3·2^30 doesn't divide 2^32: a quarter of the 32-bit draws are retried.
    const rng = seededRandom(1);
    const max = 3 * 2 ** 30;
    const values = Array.from({ length: 200 }, () => rng.nextInt(max));
    expect(values.every((value) => Number.isInteger(value) && value >= 0 && value < max)).toBe(
      true,
    );
  });

  it("refuses an invalid range", () => {
    expect(() => seededRandom(1).nextInt(0)).toThrow(RangeError);
  });
});

describe("scriptedRandom", () => {
  it("replays the given draws within range, then continues from the fallback", () => {
    const rng = scriptedRandom([5, 1], { nextInt: () => 0 });
    expect([rng.nextInt(3), rng.nextInt(3), rng.nextInt(3)]).toEqual([2, 1, 0]);
    expect(() => rng.nextInt(-1)).toThrow(RangeError);
  });
});

describe("canonical JSON", () => {
  it("sorts object keys at every depth", () => {
    expect(canonical({ b: 1, a: { d: [1, { f: 1, e: 2 }], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[1,{"e":2,"f":1}]},"b":1}',
    );
    expect(sameJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(canonical(undefined)).toBe("undefined");
    expect(sameJson(undefined, null)).toBe(false);
  });

  it.each([
    [{ a: [1, "x", true, null, { b: 2 }] }, true],
    [Object.assign(Object.create(null) as object, { a: 1 }), true],
    [{ a: undefined }, false],
    [{ a: Number.NaN }, false],
    [{ a: Number.POSITIVE_INFINITY }, false],
    [{ a: new Map() }, false],
    [{ a: new Date(0) }, false],
    [{ a: () => 1 }, false],
    [[1, 2n], false],
    [Symbol("x"), false],
  ])("isPlainJson(%#) → %s", (value, expected) => {
    expect(isPlainJson(value)).toBe(expected);
  });
});
