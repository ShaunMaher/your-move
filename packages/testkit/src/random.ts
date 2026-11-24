/**
 * Seeded randomness for tests (08 T10: seeded sources exist only in tests). The kit plays every
 * game from a seed and prints it with each failure, so a failure can be replayed.
 */
import { assertRange, type RandomSource } from "@your-move/sdk";

/**
 * A deterministic `RandomSource` (sfc32, seeded from one 32-bit integer). Unbiased: values come
 * from rejection sampling over 32-bit draws. For tests only, never for real games.
 *
 * @public
 */
export function seededRandom(seed: number): RandomSource {
  let a = 0x9e3779b9;
  let b = 0x243f6a88;
  let c = 0xb7e15162;
  let d = seed >>> 0;
  const next = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i += 1) next();
  return {
    nextInt(maxExclusive) {
      assertRange(maxExclusive);
      // The largest multiple of maxExclusive that fits in 32 bits: draws at or above it are retried.
      const limit = 2 ** 32 - (2 ** 32 % maxExclusive);
      for (;;) {
        const value = next();
        if (value < limit) return value % maxExclusive;
      }
    },
  };
}

/**
 * A source that returns `draws` (reduced into the requested range) and then continues from
 * `fallback`. The kit uses it to repeat a transition on a perturbed state "with the same draws"
 * even when the perturbed state asks for them differently.
 */
export function scriptedRandom(draws: readonly number[], fallback: RandomSource): RandomSource {
  let next = 0;
  return {
    nextInt(maxExclusive) {
      assertRange(maxExclusive);
      const value = draws[next];
      next += 1;
      return value === undefined ? fallback.nextInt(maxExclusive) : value % maxExclusive;
    },
  };
}
