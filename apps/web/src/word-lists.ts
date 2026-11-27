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
 * The game's own list, when it is public, is opened for the board as `resources.dictionary`
 * (02 §3): its bytes are hashed and checked to be a word list (lower-case `a`–`z` words, sorted)
 * once, as they are downloaded (and only then stored) or as they are read back from the cache,
 * where an entry that fails is deleted and downloaded again once; then it gets lookups over the
 * sorted text, as the server does them (words §9.4), with nothing built. An opened list is kept
 * by its URL, which names its content, so another game with the same list gets the same object;
 * the three most recently used are kept. The board uses it for the no-play hint (words §10.8) and to preview
 * plays locally (words §10.5); previews fall back to the server without it.
 */
import { checkWordList, createWordList } from "@your-move/dictionary";
import type { PublicWordList } from "@your-move/sdk/client";

import type { GameEnvelope } from "./game-api.js";

type Resource = GameEnvelope["resources"][number];

/** Not the shell's precache name, so the service worker's clean-up of old versions keeps it. */
export const WORD_LIST_CACHE = "dictionaries-v1";
const KEEP = 3;

/** The one shape the server serves lists at (03 §10): a same-origin path, never a full URL. */
const SERVED = /^\/assets\/dictionaries\/[A-Za-z0-9_-]+-v(\d+)\.([0-9a-f]{16})\.txt$/u;

/** A public list the server serves: where, its version, and the start of its content's hash. */
interface Served {
  readonly path: string;
  readonly id: string;
  readonly version: number;
  readonly expected: string;
}

/** The lists opened so far in this page, by path, the most recently used last; at most `KEEP`. */
const opened = new Map<string, PublicWordList>();

async function digestPrefix(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The resource as a served public list, or null: never a list that doesn't say it is public. */
function served(resource: Resource): Served | null {
  if (resource.distribution !== "public" || resource.downloadUrl === undefined) return null;
  const match = SERVED.exec(resource.downloadUrl);
  if (match === null) return null;
  const [, version = "", expected = ""] = match;
  return { path: resource.downloadUrl, id: resource.id, version: Number(version), expected };
}

/**
 * The game's word list: its one resource of kind `dictionary`. With none, or more than one, the
 * shell can't tell which list the game plays with, and hands over nothing.
 */
function gameList(resources: GameEnvelope["resources"]): Resource | null {
  // Only dictionaries exist today (05); a later kind must never be taken for a word list.
  const lists = resources.filter((resource) => {
    const kind: string = resource.kind;
    return kind === "dictionary";
  });
  return lists.length === 1 ? (lists[0] ?? null) : null;
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

/**
 * The list's text if its bytes hash to its name and it is a word list in the built format
 * (lower-case `a`–`z` words, sorted, one per line), else null.
 */
async function intact(bytes: ArrayBuffer, list: Served): Promise<string | null> {
  if ((await digestPrefix(bytes)) !== list.expected) return null;
  const text = new TextDecoder().decode(bytes);
  return checkWordList(text).ok ? text : null;
}

/** Downloads a list and stores it only if it is intact: its text, or null. */
async function download(cache: Cache, list: Served): Promise<string | null> {
  const response = await fetch(list.path, { credentials: "omit", redirect: "error" });
  if (!response.ok) return null;
  const bytes = await response.arrayBuffer();
  const text = await intact(bytes, list);
  if (text === null) return null;
  await cache.put(list.path, new Response(bytes, { headers: { "Content-Type": "text/plain" } }));
  return text;
}

/**
 * A cached list's text if it is still intact, else null; an entry that isn't is deleted, so the
 * caller downloads it again and no bad entry is read twice.
 */
async function cachedText(cache: Cache, list: Served): Promise<string | null> {
  const response = await cache.match(list.path);
  if (response === undefined) return null;
  const text = await intact(await response.arrayBuffer(), list);
  if (text === null) await cache.delete(list.path);
  return text;
}

/** Opens a list for the board (hashing and checking it once), or null if it isn't intact. */
async function open(cache: Cache, list: Served): Promise<PublicWordList | null> {
  const known = opened.get(list.path);
  if (known !== undefined) {
    // Most recently used goes last, so the least recently used is the one dropped.
    opened.delete(list.path);
    opened.set(list.path, known);
    return known;
  }
  const text = (await cachedText(cache, list)) ?? (await download(cache, list));
  if (text === null) return null;
  const words = createWordList(list.id, list.version, text);
  opened.set(list.path, words);
  for (const path of opened.keys()) {
    if (opened.size <= KEEP) break;
    opened.delete(path);
  }
  return words;
}

/** Makes sure a list is cached (downloading it if it isn't); it is hashed and checked only then. */
async function ensure(cache: Cache, list: Served): Promise<void> {
  if ((await cache.match(list.path)) === undefined) await download(cache, list);
}

/** One run at a time: two overlapping runs would both trim the same listing. */
let running: Promise<unknown> = Promise.resolve();

/**
 * Caches the game's public word lists and opens its own list for its board (02 §3), or null:
 * when it isn't public, can't be downloaded, doesn't hash to its name (a cached entry that
 * doesn't is downloaded again once), isn't a word list, or there is no Cache Storage. Best
 * effort: a failure changes nothing the player sees but the hint (words §10.8). Calls run one
 * after another.
 */
export function openWordList(resources: GameEnvelope["resources"]): Promise<PublicWordList | null> {
  const run = running.then(() => openAll(resources));
  // The chain never rejects: one failed run must not stop the next from starting.
  running = run.catch(() => undefined);
  return run.catch(() => null);
}

async function openAll(resources: GameEnvelope["resources"]): Promise<PublicWordList | null> {
  if (typeof caches === "undefined") return null;
  const own = gameList(resources);
  const lists = resources.map(served).filter((list) => list !== null);
  if (lists.length === 0) return null;
  const cache = await caches.open(WORD_LIST_CACHE);
  let words: PublicWordList | null = null;
  for (const list of lists) {
    try {
      if (list.path === own?.downloadUrl) words = await open(cache, list);
      else await ensure(cache, list);
    } catch {
      // Best effort: the next list is still tried.
    }
  }
  await keepRecent(cache, new Set(lists.map((list) => list.path)));
  return words;
}
