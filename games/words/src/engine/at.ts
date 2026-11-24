/**
 * Indexed access for arrays the rules guarantee are long enough, such as per-seat arrays indexed
 * by a playing seat. A missing element is an engine bug, so it throws (02 §2.1 rule 3).
 */
export function at<T>(items: readonly T[], index: number): T {
  if (index < 0 || index >= items.length) {
    throw new RangeError(`index ${String(index)} is out of range`);
  }
  return items[index] as T;
}
