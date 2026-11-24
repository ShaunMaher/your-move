/**
 * Word lookup: a binary search directly over a word list's text (docs/spec/games/words.md §9.4,
 * 03 §10). No index is built, so loading a dictionary costs only I/O and no request pays a parse
 * cost; one lookup reads about log2(n) lines of at most 15 characters.
 */
import { isWord } from "./format.js";

/**
 * Whether `word` is in `text`, a valid word list (see `checkWordList`). Anything that can't be a
 * word (wrong length, characters other than `a`–`z`) is never found. A text without its final
 * newline still terminates: its last line ends at the end of the text.
 */
export function hasWord(text: string, word: string): boolean {
  if (!isWord(word)) return false;
  // [low, high) holds whole lines: low is the start of a line, high the start of a line or the end.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    // lastIndexOf treats a negative position as 0, so a text starting with "\n" needs the guard.
    const start = middle === 0 ? 0 : text.lastIndexOf("\n", middle - 1) + 1;
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
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

/** Thrown for a text that isn't in the word-list format (the final newline is missing). */
export class WordListFormatError extends Error {
  constructor(id: string) {
    super(`dictionary ${id}: the word list must be empty or end with a newline`);
    this.name = "WordListFormatError";
  }
}

/**
 * A `WordList` over one word list's text, which must be empty or end with a newline. The rest of
 * the format is the build's (or, in M6, the upload validation's) to guarantee: checking it here
 * would cost a full pass at load.
 */
export function createWordList(id: string, version: number, text: string): WordList {
  if (text !== "" && !text.endsWith("\n")) throw new WordListFormatError(id);
  return Object.freeze({ id, version, has: (word: string) => hasWord(text, word) });
}
