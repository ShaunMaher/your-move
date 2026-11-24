/**
 * Building one dictionary (docs/spec/games/words.md §9.1): check the upstream list against the
 * SHA-256 in `meta.json`, keep its `a`–`z` words of length 2..15, apply our additions and
 * removals and the global removals (Q7), and produce the compact word list with its manifest. Pure
 * apart from hashing, so it is tested directly; `files.ts` does the reading and writing.
 */
import { z } from "zod";

import {
  checkWordList,
  formatWordList,
  isWord,
  MAX_WORD_LENGTH,
  MIN_WORD_LENGTH,
} from "../format.js";
import { DICTIONARY_ID, LANGUAGE, type DictionaryManifest } from "../manifest.js";

/** `meta.json` (words §9.1). */
const metaSchema = z
  .object({
    id: z.string().regex(DICTIONARY_ID),
    version: z.number().int().min(1),
    name: z.string().min(1).max(60),
    description: z.string().min(1).max(300),
    language: z.string().regex(LANGUAGE),
    licence: z.string().min(1),
    sourceUrl: z.url({ protocol: /^https$/u }),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

/** The files of one `dictionaries/<id>/` directory. */
export interface DictionarySources {
  /** `meta.json`, as parsed JSON. */
  readonly meta: unknown;
  /** `source.txt`, byte for byte. */
  readonly source: Uint8Array<ArrayBuffer>;
  /** `additions.txt` and `removals.txt`. */
  readonly additions: string;
  readonly removals: string;
}

export interface BuiltDictionary {
  /** The compact word list (`words.txt`). */
  readonly text: string;
  readonly manifest: DictionaryManifest;
}

/** A dictionary that can't be built; the message names the file and line, never a word. */
export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildError";
  }
}

/** The SHA-256 of some bytes, as lower-case hex. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Our edit files (`additions.txt`, `removals.txt`, `removals-global.txt`): one word per line,
 * strictly sorted, nothing else (no comments, no blank lines), and a final newline. An empty file
 * is an empty list.
 */
export function parseEdits(file: string, text: string): string[] {
  if (text.length === 0) return [];
  if (!text.endsWith("\n")) throw new BuildError(`${file}: the last line must end with a newline`);
  const words = text.slice(0, -1).split("\n");
  words.forEach((word, index) => {
    const line = String(index + 1);
    if (!isWord(word)) {
      throw new BuildError(
        `${file} line ${line}: not a word of ${String(MIN_WORD_LENGTH)}–${String(MAX_WORD_LENGTH)} letters a–z`,
      );
    }
    const previous = words[index - 1];
    if (previous !== undefined && previous >= word) {
      throw new BuildError(`${file} line ${line}: lines must be sorted with no duplicates`);
    }
  });
  return words;
}

/** The upstream list's words, and how many lines were dropped and why. */
function readSource(source: Uint8Array): {
  words: Set<string>;
  skipped: { length: number; characters: number };
} {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new BuildError("source.txt: not valid UTF-8");
  }
  const words = new Set<string>();
  const skipped = { length: 0, characters: 0 };
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length === 0) continue;
    // Never lower-cased: a capitalised line is a proper noun or an abbreviation, not a word.
    if (!/^[a-z]+$/u.test(line)) skipped.characters += 1;
    else if (!isWord(line)) skipped.length += 1;
    else words.add(line);
  }
  return { words, skipped };
}

/** Builds one dictionary; `globalRemovals` is `removals-global.txt`, applied to every list (Q7). */
export async function buildDictionary(
  sources: DictionarySources,
  globalRemovals: string,
): Promise<BuiltDictionary> {
  const parsed = metaSchema.safeParse(sources.meta);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    throw new BuildError(`meta.json is invalid (${fields})`);
  }
  const meta = parsed.data;
  const sourceSha256 = await sha256Hex(sources.source);
  if (sourceSha256 !== meta.sha256) {
    throw new BuildError("source.txt doesn't match the sha256 in meta.json");
  }

  const { words, skipped } = readSource(sources.source);
  const additions = parseEdits("additions.txt", sources.additions);
  additions.forEach((word, index) => {
    if (words.has(word)) {
      throw new BuildError(`additions.txt line ${String(index + 1)}: already in source.txt`);
    }
  });
  for (const word of additions) words.add(word);
  const removals = parseEdits("removals.txt", sources.removals);
  removals.forEach((word, index) => {
    if (!words.has(word) || additions.includes(word)) {
      throw new BuildError(
        `removals.txt line ${String(index + 1)}: not a word of source.txt (or it is one of additions.txt)`,
      );
    }
  });
  for (const word of removals) words.delete(word);
  for (const word of parseEdits("removals-global.txt", globalRemovals)) words.delete(word);

  const text = formatWordList(words);
  const check = checkWordList(text);
  if (!check.ok) throw new BuildError(`the built list is invalid (${check.problem})`);
  return {
    text,
    manifest: {
      id: meta.id,
      version: meta.version,
      name: meta.name,
      description: meta.description,
      language: meta.language,
      licence: meta.licence,
      sourceUrl: meta.sourceUrl,
      sourceSha256,
      distribution: "public",
      wordCount: check.wordCount,
      alphabet: [...check.alphabet],
      sha256: await sha256Hex(new TextEncoder().encode(text)),
      bytes: text.length,
      skipped,
    },
  };
}
