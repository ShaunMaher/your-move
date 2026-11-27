/**
 * The public word lists a game uses (07 §3, §4; words §9.4): downloaded from the envelope's
 * versioned, hashed `downloadUrl` and kept in Cache Storage, so a list is fetched once and then
 * available offline. A list is stored only after its content hashes to the digest in its own
 * file name, so a corrupted or swapped download is never kept. Only the three lists added most
 * recently stay (Cache Storage lists its keys in the order they were added), except that the
 * lists of the game being opened are never evicted for it. Only a resource marked
 * `distribution: "public"` is downloaded, whatever else it carries: `serverOnly` lists are never
 * fetched, and a URL on a resource that doesn't say it is public is not followed.
 *
 * The game's own list, when it is public, is then read back from the cache, checked against its
 * hash again, and handed to the board as `resources.dictionary` (02 §3): lookups over the sorted
 * text, as the server does them (words §9.4), with nothing built. The board uses it for the
 * no-play hint (words §10.8); its previews still come from the server.
 */
import { createWordList } from "@your-move/dictionary";
import type { PublicWordList } from "@your-move/sdk/client";

import type { GameEnvelope } from "./game-api.js";

/** Not the shell's precache name, so the service worker's clean-up of old versions keeps it. */
export const WORD_LIST_CACHE = "dictionaries-v1";
const KEEP = 3;

/** The one shape the server serves lists at (03 §10): a same-origin path, never a full URL. */
const SERVED = /^\/assets\/dictionaries\/[A-Za-z0-9_-]+-v(\d+)\.([0-9a-f]{16})\.txt$/u;

async function digestPrefix(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Drops the oldest lists beyond `KEEP`, never one of `protectedPaths`. */
async function keepRecent(cache: Cache, protectedPaths: ReadonlySet<string>): Promise<void> {
  const keys = await cache.keys();
  let excess = keys.length - KEEP;
  for (const request of keys) {
    if (excess <= 0) return;
    if (protectedPaths.has(new URL(request.url).pathname)) continue;
    await cache.delete(request);
    excess -= 1;
  }
}

/** Downloads and caches one list; resolves to whether it is now in the cache. */
async function ensure(cache: Cache, path: string, expected: string): Promise<boolean> {
  if ((await cache.match(path)) !== undefined) return true;
  const response = await fetch(path, { credentials: "omit", redirect: "error" });
  if (!response.ok) return false;
  const bytes = await response.arrayBuffer();
  if ((await digestPrefix(bytes)) !== expected) return false;
  await cache.put(path, new Response(bytes, { headers: { "Content-Type": "text/plain" } }));
  return true;
}

/** One run at a time: two overlapping runs would both trim the same listing. */
let running: Promise<void> = Promise.resolve();

/**
 * Makes sure the public word lists of a game are cached. Best effort: a failure (offline, no Cache
 * Storage, a bad download) changes nothing the player sees, because previews then come from the
 * server (02 §3). Calls are run one after another.
 */
export function cacheWordLists(resources: GameEnvelope["resources"]): Promise<void> {
  const run = running.then(() => cacheAll(resources));
  // The chain never rejects: one failed run must not stop the next from starting.
  running = run.catch(() => undefined);
  return run;
}

async function cacheAll(resources: GameEnvelope["resources"]): Promise<void> {
  if (typeof caches === "undefined") return;
  const wanted = new Map<string, string>();
  for (const resource of resources) {
    if (resource.distribution !== "public" || resource.downloadUrl === undefined) continue;
    const expected = SERVED.exec(resource.downloadUrl)?.[2];
    if (expected !== undefined) wanted.set(resource.downloadUrl, expected);
  }
  if (wanted.size === 0) return;
  try {
    const cache = await caches.open(WORD_LIST_CACHE);
    for (const [path, expected] of wanted) {
      try {
        await ensure(cache, path, expected);
      } catch {
        // Best effort: the next list is still tried.
      }
    }
    await keepRecent(cache, new Set(wanted.keys()));
  } catch {
    // Best effort.
  }
}

/**
 * The game's word list for its board (02 §3), or null: the game's dictionary resource, only when
 * it is marked `distribution: "public"`, cached (downloaded and stored first if it isn't yet, as
 * `cacheWordLists` does), and its content still hashes to the digest in its name. Any failure
 * (offline, no Cache Storage, a bad download or a changed entry) is null, and the board goes on
 * without it. Runs in turn with `cacheWordLists`.
 */
export function openWordList(resources: GameEnvelope["resources"]): Promise<PublicWordList | null> {
  const run = running.then(async () => {
    await cacheAll(resources);
    return readList(resources);
  });
  running = run.then(
    () => undefined,
    () => undefined,
  );
  return run.catch(() => null);
}

async function readList(resources: GameEnvelope["resources"]): Promise<PublicWordList | null> {
  if (typeof caches === "undefined") return null;
  // A game's resources are its word list (every resource is a dictionary, 05); only a public one
  // ever reaches the board.
  const [resource] = resources;
  if (resource?.distribution !== "public" || resource.downloadUrl === undefined) return null;
  const served = SERVED.exec(resource.downloadUrl);
  if (served === null) return null;
  const [, version = "", expected = ""] = served;
  const cache = await caches.open(WORD_LIST_CACHE);
  const response = await cache.match(resource.downloadUrl);
  if (response === undefined) return null;
  const bytes = await response.arrayBuffer();
  if ((await digestPrefix(bytes)) !== expected) return null;
  // A list that isn't one (no final newline) throws, and the caller gets null.
  return createWordList(resource.id, Number(version), new TextDecoder().decode(bytes));
}
