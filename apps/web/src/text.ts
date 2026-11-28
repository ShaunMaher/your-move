/** Small text helpers for the sign-in and new-game screens. */

/** The code field accepts pasted or autofilled text such as `1234 5678` (06 §3.3). */
export function cleanCode(input: string): string {
  return input.replace(/\D/gu, "").slice(0, CODE_LENGTH);
}

export const CODE_LENGTH = 8;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemeCount(text: string): number {
  return Array.from(segmenter.segment(text)).length;
}

/** The display-name length rule, checked early so the common mistake needs no round trip (06 §5.1). */
export const DISPLAY_NAME_MAX = 24;

/**
 * A cheap look at an email field before sending; the server is the real check. The domain needs a
 * dot with something after it, since the server refuses `name@host` (04 conventions on stored
 * addresses; `normaliseAddress` in `packages/server/src/accounts/email.ts`). Only the ASCII full
 * stop counts: a domain written with U+3002, U+FF0E or U+FF61 is refused here, which is rare and
 * fixed by typing an ASCII dot.
 */
export function looksLikeEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[^\s@.]+$/u.test(input.trim());
}

const playedDate = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const untilDate = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

/** When a join link stops working (07 §1), in the device's locale. */
export function linkUntil(at: number): string {
  return untilDate.format(new Date(at));
}

/** "last played <date>" for a past opponent (07 §1.1), in the device's locale. */
export function lastPlayed(at: number): string {
  return `last played ${playedDate.format(new Date(at))}`;
}

/**
 * `now` resized to `open` address fields (07 §1.1): new fields are empty; when there are too many,
 * empty ones go first (the latest first), then the latest typed ones.
 */
export function fitAddresses(now: readonly string[], open: number): string[] {
  const size = Math.max(0, open);
  const kept = [...now];
  while (kept.length > size) {
    const empty = kept.findLastIndex((address) => address.trim() === "");
    kept.splice(empty === -1 ? kept.length - 1 : empty, 1);
  }
  while (kept.length < size) kept.push("");
  return kept;
}
