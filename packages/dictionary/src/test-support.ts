/** Test helpers: a valid manifest for a given word list. */
import { checkWordList } from "./format.js";
import { sha256TextHex } from "./hash.js";
import type { DictionaryManifest } from "./manifest.js";

/** A manifest describing `text` (a valid word list), with its real hash and size. */
export async function manifestFor(
  id: string,
  text: string,
  version = 1,
): Promise<DictionaryManifest> {
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
    sha256: "0".repeat(64),
    distribution: "public",
    wordCount: check.wordCount,
    alphabet: [...check.alphabet],
    wordsSha256: await sha256TextHex(text),
    bytes: text.length,
    skipped: { length: 0, characters: 0 },
  };
}
