/**
 * `DictionaryProvider` (03 §10): the built-in dictionaries' catalog, and their word lists loaded
 * lazily by id and cached for the life of the isolate or process. Where the text comes from is the
 * runtime's choice, passed in as `loadText`: a bundled text module, a static asset fetched once, or
 * a file read from disk. The framework's `ResourceProvider` (M3) builds on it, adding
 * `DICTIONARIES_ENABLED` and, in M6, the `serverOnly` lists, whose own byte-sized cache sits beside
 * this one; both look words up with the same `createWordList`.
 *
 * Contract for `loadText` (10 M3): it resolves only once it holds the whole text (an asset fetch
 * reads the entire body inside the load, never a stream consumed later), it gives up after a
 * timeout, and the runtime caches its failures briefly so an unavailable asset isn't refetched on
 * every request. This provider forgets a failed load, so the next use after that retries.
 */
import type { ResourceMeta } from "@your-move/sdk";

import { sha256TextHex } from "./hash.js";
import { createWordList, type WordList } from "./lookup.js";
import { toResourceMeta, type DictionaryIndex, type DictionaryManifest } from "./manifest.js";

export interface DictionaryProviderOptions {
  /** The build's index of built-in dictionaries, already parsed (`parseIndex`). */
  readonly index: DictionaryIndex;
  /** Loads one dictionary's built word list (`words.txt`) as text; see the contract above. */
  readonly loadText: (manifest: DictionaryManifest) => Promise<string>;
}

export interface DictionaryProvider {
  /** Metadata of every built-in dictionary, never contents (08 T22). */
  catalog(): readonly ResourceMeta[];
  /** The dictionary with this id, loaded and verified on first use; undefined for an unknown id. */
  load(id: string): Promise<WordList | undefined>;
}

/** Thrown when a loaded word list isn't the one the manifest describes (a stale or damaged asset). */
export class DictionaryMismatchError extends Error {
  constructor(id: string) {
    super(`dictionary ${id}: the loaded word list doesn't match its manifest`);
    this.name = "DictionaryMismatchError";
  }
}

export function createDictionaryProvider(options: DictionaryProviderOptions): DictionaryProvider {
  const manifests = new Map(options.index.dictionaries.map((manifest) => [manifest.id, manifest]));
  const catalog = Object.freeze(options.index.dictionaries.map(toResourceMeta));
  const loaded = new Map<string, Promise<WordList>>();

  const loadOne = async (manifest: DictionaryManifest): Promise<WordList> => {
    const text = await options.loadText(manifest);
    // Verified once per load, before first use: a stale list of the same size would otherwise
    // answer lookups wrongly. The cost (a few milliseconds per isolate or process) is in
    // packages/dictionary/README.md.
    if (text.length !== manifest.bytes || (await sha256TextHex(text)) !== manifest.wordsSha256) {
      throw new DictionaryMismatchError(manifest.id);
    }
    return createWordList(manifest.id, manifest.version, text);
  };

  return {
    catalog: () => catalog,
    load(id) {
      const manifest = manifests.get(id);
      if (manifest === undefined) return Promise.resolve(undefined);
      let pending = loaded.get(id);
      if (pending === undefined) {
        // Concurrent first uses share one load; a failed load is forgotten so the next use retries.
        pending = loadOne(manifest);
        loaded.set(id, pending);
        pending.catch(() => loaded.delete(id));
      }
      return pending;
    },
  };
}
