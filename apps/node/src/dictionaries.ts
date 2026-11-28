/**
 * The built-in dictionaries on Node (docs/spec/03-architecture.md §10): read from disk, from the
 * served layout the dictionary build publishes (`index.json` and each word list under its
 * versioned, hashed name). The build copies it to `dist/dictionaries`; the same directory is
 * served to clients at `/assets/dictionaries/`.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { type BuiltinDictionaries, parseIndex, servedFileName } from "@your-move/server";

/** Thrown at startup when the dictionaries directory is missing or its index is invalid. */
export class DictionariesError extends Error {
  override readonly name = "DictionariesError";
}

export function nodeDictionaries(dir: string): BuiltinDictionaries {
  let index: ReturnType<typeof parseIndex>;
  try {
    index = parseIndex(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")));
  } catch {
    throw new DictionariesError(
      `The built-in dictionaries are missing or invalid in ${dir} (build them with pnpm build).`,
    );
  }
  return {
    index,
    // The whole file, read at once: the provider checks its size and hash before first use.
    loadText: (manifest) => readFile(join(dir, servedFileName(manifest)), "utf8"),
  };
}
