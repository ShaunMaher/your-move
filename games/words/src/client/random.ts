/**
 * A WebCrypto random source for the rack shuffle (CLAUDE.md: production randomness is WebCrypto
 * only). The shuffle is cosmetic, but it is unbiased all the same: rejection sampling, no modulo
 * bias, as `shuffle` expects of a `RandomSource`.
 */
import type { RandomSource } from "@your-move/sdk";

const RANGE = 2 ** 32;

export const webCryptoRandom: RandomSource = {
  nextInt(maxExclusive: number): number {
    const limit = RANGE - (RANGE % maxExclusive);
    const draw = new Uint32Array(1);
    for (;;) {
      crypto.getRandomValues(draw);
      const value = draw[0] ?? 0;
      if (value < limit) return value % maxExclusive;
    }
  },
};
