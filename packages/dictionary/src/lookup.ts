/**
 * Word lookup: a binary search directly over a word list's text (docs/spec/games/words.md §9.4,
 * 03 §10). No index is built, so loading a dictionary costs only I/O and no request pays a parse
 * cost; one lookup reads about log2(n) lines of at most 15 characters.
 */
import { isWord } from "./format.js";

/**
 * Whether `word` is in `text`, a valid word list (see `checkWordList`). Anything that can't be a
 * word (wrong length, characters other than `a`–`z`) is never found.
 */
export function hasWord(text: string, word: string): boolean {
  if (!isWord(word)) return false;
  // [low, high) holds whole lines: low is the start of a line, high the start of a line or the end.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const start = text.lastIndexOf("\n", middle - 1) + 1;
    const end = text.indexOf("\n", start);
    const candidate = text.slice(start, end);
    if (candidate === word) return true;
    if (candidate < word) low = end + 1;
    else high = start;
  }
  return false;
}

/** A loaded dictionary as the words engine receives it (`Resources["dictionary"]`, 02 §2). */
export interface WordList {
  readonly id: string;
  readonly version: number;
  has(word: string): boolean;
}

/** A `WordList` over one word list's text. */
export function createWordList(id: string, version: number, text: string): WordList {
  return { id, version, has: (word) => hasWord(text, word) };
}
