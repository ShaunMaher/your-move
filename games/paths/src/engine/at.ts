/**
 * Small helpers for the engine.
 */

/**
 * Indexed access for arrays the rules guarantee are long enough, such as per-seat arrays indexed
 * by a seat in the game. A missing element is an engine bug, so it throws (02 §2.1 rule 3).
 */
export function at<T>(items: readonly T[], index: number): T {
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    throw new RangeError(`index ${String(index)} is out of range`);
  }
  return items[index] as T;
}

/** Sorts numbers ascending, as hands are kept. */
export const ascending = (a: number, b: number): number => a - b;
