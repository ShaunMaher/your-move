/**
 * Word lookup: a binary search directly over a word list's text (docs/spec/games/words.md §9.4,
 * 03 §10). No index is built, so loading a dictionary costs only I/O and no request pays a parse
 * cost; one lookup reads about log2(n) lines of at most 15 characters, in place. The same lookups
 * serve a public list on the client (02 §3, words §10.8): the list stays one string, about one
 * byte a character in the browser's memory (1.7 MB for the built-in list), with nothing built.
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
    const order = compareLine(text, start, end, word);
    if (order === 0) return true;
    if (order < 0) low = end + 1;
    else high = start;
  }
  return false;
}

/**
 * How the line `text[start, end)` sorts against `key`, as JavaScript compares strings (code unit
 * by code unit, a prefix first): negative before, 0 equal, positive after. Nothing is copied.
 */
function compareLine(text: string, start: number, end: number, key: string): number {
  const length = Math.min(end - start, key.length);
  for (let i = 0; i < length; i += 1) {
    const difference = text.charCodeAt(start + i) - key.charCodeAt(i);
    if (difference !== 0) return difference;
  }
  return end - start - key.length;
}

/** Only lower-case `a`–`z`: a prefix of some word, or the empty prefix. */
const PREFIX = /^[a-z]*$/u;
const A = 97;
/** The character after `z`: `prefix + AFTER_Z` sorts after every word that starts with `prefix`. */
const AFTER_Z = "{";

/** The offset of the first line of `text` that is not before `key`, or `text.length`. */
function lowerBound(text: string, key: string): number {
  // As in `hasWord`: [low, high) holds whole lines, every line before low is before key and every
  // line from high on is not.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const start = middle === 0 ? 0 : text.lastIndexOf("\n", middle - 1) + 1;
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    if (compareLine(text, start, end, key) < 0) low = end + 1;
    else high = start;
  }
  return Math.min(low, text.length);
}

/**
 * The letters that follow `prefix` in some word of `text` (a valid word list), as a bit mask: bit
 * 0 for `a` up to bit 25 for `z` (words §10.8). Each letter costs one binary search, which then
 * skips every word under it, so the answer reads a few dozen lines at most and builds nothing.
 */
export function followingLetters(text: string, prefix: string): number {
  if (!PREFIX.test(prefix)) return 0;
  let mask = 0;
  for (let at = lowerBound(text, prefix); at < text.length;) {
    // A prefix holds no line break, so this fails on any line shorter than it.
    if (!text.startsWith(prefix, at)) break;
    const next = text.charCodeAt(at + prefix.length) - A;
    if (!(next >= 0 && next <= 25)) {
      // The word is the prefix itself (its line, or the text, ends here): the next line may go on.
      const newline = text.indexOf("\n", at);
      if (newline === -1) break;
      at = newline + 1;
      continue;
    }
    mask |= 1 << next;
    at = lowerBound(text, prefix + String.fromCharCode(A + next) + AFTER_Z);
  }
  return mask;
}

/**
 * A loaded dictionary: as the words engine receives it (`Resources["dictionary"]`, 02 §2), and as
 * the shell hands a public one to a board (`BoardResources["dictionary"]`, 02 §3).
 */
export interface WordList {
  readonly id: string;
  readonly version: number;
  has(word: string): boolean;
  /** The letters that follow `prefix` in some word, as a bit mask (see `followingLetters`). */
  follows(prefix: string): number;
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
  return Object.freeze({
    id,
    version,
    has: (word: string) => hasWord(text, word),
    follows: (prefix: string) => followingLetters(text, prefix),
  });
}
