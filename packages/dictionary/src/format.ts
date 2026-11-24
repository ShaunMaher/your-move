/**
 * The compact word-list format every dictionary is served and looked up in (docs/spec/games/words.md
 * §9.1, §9.4): lower-case `a`–`z` words of length 2..15, strictly sorted by code unit, each
 * followed by `\n`. Lookup is a binary search straight over this text, so nothing is parsed or
 * indexed when a dictionary loads (03 §10).
 */

/** The shortest word kept (words §9.1). */
export const MIN_WORD_LENGTH = 2;

/**
 * The longest word kept: the largest board in any bundled ruleset (words §9.1). Longer words can't
 * be played and are dropped when a list is built.
 */
export const MAX_WORD_LENGTH = 15;

const WORD = /^[a-z]+$/u;

/** Whether a string may appear in a word list. */
export function isWord(word: string): boolean {
  return word.length >= MIN_WORD_LENGTH && word.length <= MAX_WORD_LENGTH && WORD.test(word);
}

/** Why a text is not a valid word list. */
export type WordListProblem =
  "EMPTY" | "BAD_CHARACTERS" | "BAD_LENGTH" | "NOT_SORTED" | "NO_FINAL_NEWLINE";

/** The result of checking a word list. */
export type WordListCheck =
  | { readonly ok: true; readonly wordCount: number; readonly alphabet: readonly string[] }
  | { readonly ok: false; readonly problem: WordListProblem; readonly line: number };

/**
 * Checks that a text is a valid word list in one linear pass, and computes its word count and
 * alphabet (the letters its words use, words §9.3). The build checks its own output with it; it is
 * also the validation pass uploaded lists will need (words §9.5, M6).
 */
export function checkWordList(text: string): WordListCheck {
  if (text.length === 0) return { ok: false, problem: "EMPTY", line: 0 };
  if (!text.endsWith("\n")) return { ok: false, problem: "NO_FINAL_NEWLINE", line: 0 };
  const letters = new Set<string>();
  let previous = "";
  let line = 0;
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf("\n", start);
    const word = text.slice(start, end);
    line += 1;
    if (!WORD.test(word)) return { ok: false, problem: "BAD_CHARACTERS", line };
    if (!isWord(word)) return { ok: false, problem: "BAD_LENGTH", line };
    if (word <= previous) return { ok: false, problem: "NOT_SORTED", line };
    for (const letter of word) letters.add(letter);
    previous = word;
    start = end + 1;
  }
  return { ok: true, wordCount: line, alphabet: [...letters].sort() };
}

/** A word list's text for a set of valid words: sorted, one per line, with a final newline. */
export function formatWordList(words: Iterable<string>): string {
  const sorted = [...new Set(words)].sort();
  return sorted.length === 0 ? "" : `${sorted.join("\n")}\n`;
}
