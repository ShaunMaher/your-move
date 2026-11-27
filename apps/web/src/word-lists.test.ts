import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeCacheStorage, servedName as nameFor } from "./test-support.js";

const TEXT = "aa\nab\nba\n";
const WORD_LIST_CACHE = "dictionaries-v1";

let storage: ReturnType<typeof fakeCacheStorage>;
let fetcher: ReturnType<typeof vi.fn>;
let openWordList: typeof import("./word-lists.js").openWordList;

beforeEach(async () => {
  storage = fakeCacheStorage();
  vi.stubGlobal("caches", storage);
  fetcher = vi.fn(() => Promise.resolve(new Response(TEXT)));
  vi.stubGlobal("fetch", fetcher);
  // A fresh module each time: the lists it has opened are kept for the page's life.
  vi.resetModules();
  ({ openWordList } = await import("./word-lists.js"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const list = (
  downloadUrl: string | undefined,
  distribution: "public" | "serverOnly" = "public",
) => ({
  kind: "dictionary" as const,
  id: "enable",
  name: "ENABLE",
  distribution,
  ...(downloadUrl === undefined ? {} : { downloadUrl }),
});
const cached = () => [...(storage.stores.get(WORD_LIST_CACHE)?.keys() ?? [])];

describe("caching a game's public word lists", () => {
  it("downloads a list once, without credentials, and keeps it", async () => {
    const url = await nameFor(TEXT);
    await openWordList([list(url)]);
    expect(fetcher).toHaveBeenCalledWith(url, { credentials: "omit", redirect: "error" });
    expect(cached()).toEqual([url]);
    await openWordList([list(url)]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps a list only if its content hashes to the digest in its own name", async () => {
    const url = await nameFor("different\n");
    expect(await openWordList([list(url)])).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cached()).toEqual([]);
  });

  it("never fetches a server-only list, a list without a URL, or a URL of another shape", async () => {
    const url = await nameFor(TEXT);
    for (const resource of [
      list(url, "serverOnly"),
      // A URL on a resource that doesn't say it is public is not followed.
      { ...list(url), distribution: undefined },
      list(undefined),
      list("https://evil.example/assets/dictionaries/enable-v1.0123456789abcdef.txt"),
      list("/assets/dictionaries/../../api/v1/me"),
      list("/assets/other/enable-v1.0123456789abcdef.txt"),
    ]) {
      expect(await openWordList([resource])).toBeNull();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps nothing and opens nothing when the download fails", async () => {
    const url = await nameFor(TEXT);
    fetcher.mockRejectedValueOnce(new Error("offline"));
    expect(await openWordList([list(url)])).toBeNull();
    fetcher.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    expect(await openWordList([list(url)])).toBeNull();
    expect(cached()).toEqual([]);
  });

  it("does nothing when there is no Cache Storage", async () => {
    vi.stubGlobal("caches", undefined);
    expect(await openWordList([list(await nameFor(TEXT))])).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the three most recently added lists, but not at the cost of the game's own", async () => {
    const own = ["a", "b", "c", "d"];
    const urls: string[] = [];
    for (const id of own) {
      fetcher.mockResolvedValueOnce(new Response(`${id}${id}\n`));
      urls.push(await nameFor(`${id}${id}\n`, id));
    }
    // A game that itself uses four lists keeps all four while it is open.
    await openWordList(own.map((id, i) => ({ ...list(urls[i]), id })));
    expect(cached()).toEqual(urls);
    // Another game's list then pushes out the oldest of those, not itself.
    fetcher.mockResolvedValueOnce(new Response("ee\n"));
    const other = await nameFor("ee\n", "e");
    await openWordList([{ ...list(other), id: "e" }]);
    expect(cached()).toEqual([urls[2], urls[3], other]);
  });

  it("keeps the three most recently added lists", async () => {
    const names: string[] = [];
    for (const id of ["one", "two", "three", "four"]) {
      const text = `${id}\n`;
      fetcher.mockResolvedValueOnce(new Response(text));
      const url = await nameFor(text, id);
      names.push(url);
      await openWordList([{ ...list(url), id }]);
    }
    expect(cached()).toEqual(names.slice(1));
  });

  it("runs overlapping calls one after another, so they can't trim the same listing twice", async () => {
    const texts = ["pp\n", "qq\n", "rr\n", "ss\n", "tt\n"];
    const urls = await Promise.all(texts.map((text, i) => nameFor(text, `l${String(i)}`)));
    vi.stubGlobal("fetch", (path: string) =>
      Promise.resolve(new Response(texts[urls.indexOf(path)] ?? "")),
    );
    await Promise.all(urls.map((url, i) => openWordList([{ ...list(url), id: `l${String(i)}` }])));
    expect(cached()).toEqual(urls.slice(2));
  });

  it("still runs the next call after one that failed outright", async () => {
    const url = await nameFor(TEXT);
    const broken = {
      get distribution(): never {
        throw new Error("broken resource");
      },
    };
    expect(await openWordList([broken as never])).toBeNull();
    expect(await openWordList([list(url)])).not.toBeNull();
    expect(cached()).toEqual([url]);
  });
});

describe("opening the game's word list for its board", () => {
  it("opens a public list with the server's lookups", async () => {
    const url = await nameFor(TEXT);
    const opened = await openWordList([list(url)]);
    expect(opened).toMatchObject({ id: "enable", version: 1 });
    expect(opened?.has("ab")).toBe(true);
    expect(opened?.has("bb")).toBe(false);
    expect(opened?.follows("a")).toBe(0b11);
  });

  it("hashes a list once and gives every game with it the same object (A14-P-7)", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    const url = await nameFor(TEXT);
    const hashedToName = digest.mock.calls.length;
    const first = await openWordList([list(url)]);
    const again = await openWordList([{ ...list(url), name: "Another game's copy" }]);
    expect(again).toBe(first);
    expect(digest.mock.calls.length - hashedToName).toBe(1);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("opens a list from the cache in a new page, hashing it once there", async () => {
    const url = await nameFor(TEXT);
    await openWordList([list(url)]);
    vi.resetModules();
    const fresh = await import("./word-lists.js");
    const digest = vi.spyOn(crypto.subtle, "digest");
    expect((await fresh.openWordList([list(url)]))?.has("ba")).toBe(true);
    expect(digest).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("downloads a cached entry that no longer matches its name again, once (A14-S-3)", async () => {
    const url = await nameFor(TEXT);
    const cache = await storage.open(WORD_LIST_CACHE);
    await cache.put(url, new Response("aa\nzz\n"));
    expect((await openWordList([list(url)]))?.has("ba")).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await (await cache.match(url))?.text()).toBe(TEXT);
    // A download that doesn't match either: nothing opened, nothing kept.
    await cache.put(url, new Response("aa\nzz\n"));
    vi.resetModules();
    const fresh = await import("./word-lists.js");
    fetcher.mockResolvedValueOnce(new Response("aa\nzz\n"));
    expect(await fresh.openWordList([list(url)])).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cached()).toEqual([]);
  });

  it("opens nothing that isn't public, even after a public list", async () => {
    const url = await nameFor(TEXT);
    expect(await openWordList([list(url, "serverOnly")])).toBeNull();
    expect(await openWordList([])).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("picks the game's list by kind, and opens nothing when it can't tell which (A14-S-5)", async () => {
    const url = await nameFor(TEXT);
    const other = await nameFor("zz\n", "other");
    vi.stubGlobal("fetch", (path: string) =>
      Promise.resolve(new Response(path === other ? "zz\n" : TEXT)),
    );
    // A resource of another kind first is never taken for the word list.
    const notAList = { ...list(other), kind: "image" } as unknown as ReturnType<typeof list>;
    expect((await openWordList([notAList, list(url)]))?.has("ab")).toBe(true);
    // Two word lists: which one the game plays with isn't the shell's to guess.
    expect(await openWordList([list(url), { ...list(other), id: "other" }])).toBeNull();
  });

  it.each([
    ["no final newline", "aa\nab"],
    ["a character outside a–z, which could make a lookup misbehave (A14-S-1)", "aa\naé\n"],
    ["a character above z (A14-S-1)", "a{\n"],
    ["words out of order", "ab\naa\n"],
  ])("opens and keeps nothing that isn't a word list: %s (A14-S2-1)", async (_name, text) => {
    const url = await nameFor(text);
    fetcher.mockResolvedValueOnce(new Response(text));
    expect(await openWordList([list(url)])).toBeNull();
    // Never stored, so it isn't read back from the cache on the next open.
    expect(cached()).toEqual([]);
  });

  it("deletes a cached entry that isn't a word list, and downloads it again (A14-S2-1)", async () => {
    const text = "ab\naa\n";
    const url = await nameFor(text);
    const cache = await storage.open(WORD_LIST_CACHE);
    await cache.put(url, new Response(text));
    fetcher.mockResolvedValueOnce(new Response(text));
    expect(await openWordList([list(url)])).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cached()).toEqual([]);
  });

  it("keeps the three most recently used lists open, dropping the least recently used (A14-R2-3)", async () => {
    const texts = ["aa\n", "bb\n", "cc\n", "dd\n"];
    const urls = await Promise.all(texts.map((text, i) => nameFor(text, `l${String(i)}`)));
    vi.stubGlobal("fetch", (path: string) =>
      Promise.resolve(new Response(texts[urls.indexOf(path)] ?? "")),
    );
    const openOne = (i: number) => openWordList([{ ...list(urls[i]), id: `l${String(i)}` }]);
    const [a, b] = [await openOne(0), await openOne(1)];
    await openOne(2);
    // Using A again makes B the least recently used, so the fourth list drops B, not A.
    expect(await openOne(0)).toBe(a);
    await openOne(3);
    expect(await openOne(0)).toBe(a);
    const reopened = await openOne(1);
    expect(reopened).not.toBeNull();
    expect(reopened).not.toBe(b);
  });
});
