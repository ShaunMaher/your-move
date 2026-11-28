/**
 * The built-in dictionaries on Cloudflare (docs/spec/03-architecture.md §10, games/words.md §9.4):
 * fetched from the static-assets binding, where the build publishes the word lists under
 * `/assets/dictionaries/` (the same files clients download) and the index at
 * `/dictionaries/index.json`. The index is read once
 * per isolate, when the app is built; each word list on first use, the whole body inside the load
 * (10 M3). The core adds the timeout around `loadText`, and the brief negative cache around the
 * whole load, its size and hash check included.
 */
import { type BuiltinDictionaries, parseIndex, servedFileName } from "@your-move/server";

/** Any origin: the assets binding ignores it and serves by path. */
const ASSETS_ORIGIN = "https://assets.invalid";
/** The word lists, by their versioned, hashed names (immutable, as clients download them). */
const LISTS = "/assets/dictionaries/";
/** The unversioned index, outside /assets/ so it is never cached as immutable. */
const INDEX = "/dictionaries/index.json";

async function fetchText(assets: Fetcher, path: string): Promise<string> {
  const response = await assets.fetch(new Request(`${ASSETS_ORIGIN}${path}`));
  if (!response.ok) throw new Error(`dictionary asset answered ${String(response.status)}`);
  return response.text();
}

export async function assetDictionaries(assets: Fetcher): Promise<BuiltinDictionaries> {
  const index = parseIndex(JSON.parse(await fetchText(assets, INDEX)));
  return {
    index,
    loadText: (manifest) => fetchText(assets, `${LISTS}${servedFileName(manifest)}`),
  };
}
