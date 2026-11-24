/**
 * `DictionaryProvider` (03 §10): the built-in dictionaries' catalog, and their word lists loaded
 * lazily by id and cached for the life of the isolate or process. Where the text comes from is the
 * runtime's choice, passed in as `loadText`: a bundled text module, a static asset fetched once, or
 * a file read from disk. The framework's `ResourceProvider` (M3) builds on it, adding
 * `DICTIONARIES_ENABLED` and, in M6, the `serverOnly` lists, whose own byte-sized cache sits beside
 * this one; both look words up with the same `createWordList`.
 */
import type { ResourceMeta } from "@your-move/sdk";

import { createWordList, type WordList } from "./lookup.js";
import { toResourceMeta, type DictionaryIndex, type DictionaryManifest } from "./manifest.js";

export interface DictionaryProviderOptions {
  /** The build's index of built-in dictionaries, already parsed (`parseIndex`). */
  readonly index: DictionaryIndex;
  /** Loads one dictionary's built word list (`words.txt`) as text. */
  readonly loadText: (manifest: DictionaryManifest) => Promise<string>;
}

export interface DictionaryProvider {
  /** Metadata of every built-in dictionary, never contents (08 T22). */
  catalog(): readonly ResourceMeta[];
  /** The dictionary with this id, loaded on first use; undefined for an unknown id. */
  load(id: string): Promise<WordList | undefined>;
}

/** Thrown when a loaded word list isn't the one the manifest describes (a stale or truncated asset). */
export class DictionaryMismatchError extends Error {
  constructor(id: string) {
    super(`dictionary ${id}: the loaded word list doesn't match its manifest`);
    this.name = "DictionaryMismatchError";
  }
}

export function createDictionaryProvider(options: DictionaryProviderOptions): DictionaryProvider {
  const manifests = new Map(options.index.dictionaries.map((manifest) => [manifest.id, manifest]));
  const catalog = options.index.dictionaries.map(toResourceMeta);
  const loaded = new Map<string, Promise<WordList>>();

  const loadOne = async (manifest: DictionaryManifest): Promise<WordList> => {
    const text = await options.loadText(manifest);
    // The list is ASCII, so its length in characters is its size in bytes. A full hash check
    // would cost CPU inside the first request that needs the dictionary (03 §10).
    if (text.length !== manifest.bytes) throw new DictionaryMismatchError(manifest.id);
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
