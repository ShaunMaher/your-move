/** Test helpers: a valid manifest for a given word list. */
import { checkWordList } from "./format.js";
import type { DictionaryManifest } from "./manifest.js";

const HASH = "0".repeat(64);

/** A manifest describing `text` (a valid word list), with placeholder hashes. */
export function manifestFor(id: string, text: string, version = 1): DictionaryManifest {
  const check = checkWordList(text);
  if (!check.ok) throw new Error(`not a word list: ${check.problem}`);
  return {
    id,
    version,
    name: id.toUpperCase(),
    description: `The ${id} test list.`,
    language: "en",
    licence: "CC0-1.0",
    sourceUrl: `https://example.org/${id}.txt`,
    sourceSha256: HASH,
    distribution: "public",
    wordCount: check.wordCount,
    alphabet: [...check.alphabet],
    sha256: HASH,
    bytes: text.length,
    skipped: { length: 0, characters: 0 },
  };
}
