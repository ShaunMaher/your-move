/**
 * The built-in dictionaries on Cloudflare (docs/spec/03-architecture.md §10, games/words.md §9.4):
 * fetched from the static-assets binding, where the build publishes the dictionaries' served
 * layout under `/assets/dictionaries/` (the same files clients download). The index is read once
 * per isolate, when the app is built; each word list on first use, the whole body inside the load
 * (10 M3). The core adds the timeout and the brief negative cache around `loadText`.
 */
import { type BuiltinDictionaries, parseIndex, servedFileName } from "@your-move/server";

/** Any origin: the assets binding ignores it and serves by path. */
const ASSETS_ORIGIN = "https://assets.invalid";
const PREFIX = "/assets/dictionaries/";

async function fetchText(assets: Fetcher, path: string): Promise<string> {
  const response = await assets.fetch(new Request(`${ASSETS_ORIGIN}${PREFIX}${path}`));
  if (!response.ok) throw new Error(`dictionary asset answered ${String(response.status)}`);
  return response.text();
}

export async function assetDictionaries(assets: Fetcher): Promise<BuiltinDictionaries> {
  const index = parseIndex(JSON.parse(await fetchText(assets, "index.json")));
  return {
    index,
    loadText: (manifest) => fetchText(assets, servedFileName(manifest)),
  };
}
