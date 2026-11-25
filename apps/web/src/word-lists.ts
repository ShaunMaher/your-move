/**
 * The public word lists a game uses (07 §3, §4; words §9.4): downloaded from the envelope's
 * versioned, hashed `downloadUrl` and kept in Cache Storage, so a list is fetched once and then
 * available offline. A list is stored only after its content hashes to the digest in its own
 * file name, so a corrupted or swapped download is never kept. Only the three lists used most
 * recently stay.
 *
 * `serverOnly` lists are never downloaded: the API gives them no URL, and none is asked for.
 */
import type { GameEnvelope } from "./game-api.js";

/** Not the shell's precache name, so the service worker's clean-up of old versions keeps it. */
export const WORD_LIST_CACHE = "dictionaries-v1";
const KEEP = 3;

/** The one shape the server serves lists at (03 §10): a same-origin path, never a full URL. */
const SERVED = /^\/assets\/dictionaries\/[A-Za-z0-9_-]+-v\d+\.([0-9a-f]{16})\.txt$/u;

async function digestPrefix(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function keepRecent(cache: Cache): Promise<void> {
  const keys = await cache.keys();
  for (const request of keys.slice(0, Math.max(0, keys.length - KEEP))) {
    await cache.delete(request);
  }
}

/** Downloads and caches one list; resolves to whether it is now in the cache. */
async function ensure(path: string, expected: string): Promise<boolean> {
  const cache = await caches.open(WORD_LIST_CACHE);
  if ((await cache.match(path)) !== undefined) return true;
  const response = await fetch(path, { credentials: "omit" });
  if (!response.ok) return false;
  const bytes = await response.arrayBuffer();
  if ((await digestPrefix(bytes)) !== expected) return false;
  await cache.put(path, new Response(bytes, { headers: { "Content-Type": "text/plain" } }));
  await keepRecent(cache);
  return true;
}

/**
 * Makes sure the public word lists of a game are cached. Best effort: a failure (offline, no Cache
 * Storage, a bad download) changes nothing the player sees, because previews then come from the
 * server (02 §3).
 */
export async function cacheWordLists(resources: GameEnvelope["resources"]): Promise<void> {
  if (typeof caches === "undefined") return;
  for (const resource of resources) {
    if (resource.distribution === "serverOnly" || resource.downloadUrl === undefined) continue;
    const expected = SERVED.exec(resource.downloadUrl)?.[1];
    if (expected === undefined) continue;
    try {
      await ensure(resource.downloadUrl, expected);
    } catch {
      // Best effort.
    }
  }
}
