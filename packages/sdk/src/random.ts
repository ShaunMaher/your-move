/**
 * Randomness for game engines (docs/spec/02-game-framework.md §2.1 rules 1–2, §5). Engines never
 * call `Math.random` or `crypto`: every random value arrives through a `RandomSource` argument.
 * The framework wraps its WebCrypto source with {@link recordRandom}, stores the draws, and replays
 * a game with {@link replayRandom}.
 */

/**
 * The only source of randomness an engine may use (02 §2.1 rule 2).
 *
 * @public
 */
export interface RandomSource {
  /**
   * A uniformly distributed integer in `0 .. maxExclusive - 1`. `maxExclusive` is a positive
   * safe integer no larger than 2^32.
   */
  nextInt(maxExclusive: number): number;
}

/** The largest `maxExclusive` a source must support: one 32-bit draw. */
const MAX_RANGE = 2 ** 32;

/**
 * Throws unless `maxExclusive` is a valid range for {@link RandomSource.nextInt}. Calling it with
 * anything else is a bug in the engine, so it throws rather than returning an error value.
 *
 * @public
 */
export function assertRange(maxExclusive: number): void {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > MAX_RANGE) {
    throw new RangeError("nextInt: maxExclusive must be an integer from 1 to 2^32");
  }
}

/**
 * A source that records every value drawn from `source`, in order (02 §5).
 *
 * @public
 */
export interface RecordingRandom {
  /** Draws from the wrapped source and records the result. */
  readonly rng: RandomSource;
  /** The values drawn so far, in order. */
  readonly draws: readonly number[];
}

/**
 * Wraps `source` so every value drawn is recorded, for replay (02 §2.1 rule 2).
 *
 * @public
 */
export function recordRandom(source: RandomSource): RecordingRandom {
  const draws: number[] = [];
  return {
    draws,
    rng: {
      nextInt(maxExclusive) {
        assertRange(maxExclusive);
        const value = source.nextInt(maxExclusive);
        if (!Number.isInteger(value) || value < 0 || value >= maxExclusive) {
          throw new RangeError("nextInt: the wrapped source returned a value out of range");
        }
        draws.push(value);
        return value;
      },
    },
  };
}

/**
 * Thrown by {@link replayRandom} when the recorded draws don't fit the replayed calls: a sign of a
 * corrupted log or a nondeterministic engine.
 *
 * @public
 */
export class ReplayMismatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReplayMismatchError";
  }
}

/**
 * A source that returns `draws` in order (02 §5). It throws {@link ReplayMismatchError} if the
 * engine asks for more values than were recorded or a recorded value is out of the requested
 * range; {@link ReplaySource.remaining} tells the caller whether every draw was used.
 *
 * @public
 */
export interface ReplaySource extends RandomSource {
  /** How many recorded values haven't been drawn yet. */
  remaining(): number;
}

/**
 * Replays recorded draws (02 §5).
 *
 * @public
 */
export function replayRandom(draws: readonly number[]): ReplaySource {
  let next = 0;
  return {
    nextInt(maxExclusive) {
      assertRange(maxExclusive);
      const value = draws[next];
      if (value === undefined) {
        throw new ReplayMismatchError(`replay: draw ${String(next)} was never recorded`);
      }
      if (!Number.isInteger(value) || value < 0 || value >= maxExclusive) {
        throw new ReplayMismatchError(`replay: draw ${String(next)} is out of range`);
      }
      next += 1;
      return value;
    },
    remaining: () => draws.length - next,
  };
}

/**
 * Shuffles a copy of `items` with an unbiased Fisher–Yates shuffle (08 T10).
 *
 * @public
 */
export function shuffle<T>(items: readonly T[], rng: RandomSource): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(i + 1);
    const a = result[i] as T;
    result[i] = result[j] as T;
    result[j] = a;
  }
  return result;
}
