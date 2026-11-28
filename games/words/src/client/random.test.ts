import { afterEach, describe, expect, it, vi } from "vitest";

import { webCryptoRandom } from "./random.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("webCryptoRandom", () => {
  it("draws values in range from WebCrypto", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 400; i += 1) seen.add(webCryptoRandom.nextInt(7));
    expect([...seen].every((n) => Number.isInteger(n) && n >= 0 && n < 7)).toBe(true);
    expect(seen.size).toBe(7);
  });

  it("rejects values from the biased tail instead of taking a modulus", () => {
    // For a range of 3, 2^32 mod 3 = 1, so the top value 2^32 - 1 is rejected.
    const draws = [2 ** 32 - 1, 7];
    const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint32Array) => {
      array[0] = draws.shift() ?? 0;
      return array;
    }) as typeof crypto.getRandomValues);
    expect(webCryptoRandom.nextInt(3)).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("refuses a range that isn't an integer from 1 to 2^32", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 32 + 1]) {
      expect(() => webCryptoRandom.nextInt(bad)).toThrow(RangeError);
    }
    expect(webCryptoRandom.nextInt(1)).toBe(0);
  });
});
