/**
 * Game randomness (docs/spec/03-architecture.md §4, 08 T10): the one production source, WebCrypto,
 * unbiased, built here and nowhere else; and the recording every transition wraps around its
 * source for replay (02 §2.1 rule 2, §5). Each draw is stored as a `[maxExclusive, value]` pair, so
 * a replay notices when an engine asks for a different range (10 M3, M1 review P-20).
 *
 * The source is injected (`createApp({ random })`): production passes nothing and gets
 * {@link cryptoRandom}; only tests pass a seeded one, so a failing game can be replayed.
 */
import { assertRange, type RandomSource } from "@your-move/sdk";

/** One recorded draw: the range asked for and the value returned. */
export type Draw = readonly [maxExclusive: number, value: number];

/** The source of one transition's randomness. */
export type RandomFactory = () => RandomSource;

export interface RecordedRandom {
  readonly rng: RandomSource;
  /** Every draw so far, in order. */
  readonly draws: readonly Draw[];
}

/** A uniformly random integer in `0 .. maxExclusive - 1`, by rejection sampling of 32-bit values. */
function cryptoInt(maxExclusive: number): number {
  const range = 2 ** 32;
  // The largest multiple of maxExclusive that fits: values at or above it would bias the result.
  const limit = range - (range % maxExclusive);
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] ?? 0;
    if (value < limit) return value % maxExclusive;
  }
}

/** The production source: WebCrypto (03 §4). */
export const cryptoRandom: RandomFactory = () => ({
  nextInt(maxExclusive) {
    assertRange(maxExclusive);
    return cryptoInt(maxExclusive);
  },
});

/** Records every draw from `source` as `[maxExclusive, value]`. */
export function recorded(source: RandomSource): RecordedRandom {
  const draws: Draw[] = [];
  return {
    draws,
    rng: {
      nextInt(maxExclusive) {
        assertRange(maxExclusive);
        const value = source.nextInt(maxExclusive);
        if (!Number.isInteger(value) || value < 0 || value >= maxExclusive) {
          throw new RangeError("nextInt: the source returned a value out of range");
        }
        draws.push([maxExclusive, value]);
        return value;
      },
    },
  };
}
