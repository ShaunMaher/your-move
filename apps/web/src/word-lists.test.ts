import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeCacheStorage as fakeStorage, servedName as nameFor } from "./test-support.js";
import { cacheWordLists, openWordList, WORD_LIST_CACHE } from "./word-lists.js";

const TEXT = "aa\nab\nba\n";

let storage: ReturnType<typeof fakeStorage>;
let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal("caches", storage);
  fetcher = vi.fn(() => Promise.resolve(new Response(TEXT)));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
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

describe("caching a game's public word lists", () => {
  it("downloads a list once, without credentials, and keeps it", async () => {
    const url = await nameFor(TEXT);
    await cacheWordLists([list(url)]);
    expect(fetcher).toHaveBeenCalledWith(url, { credentials: "omit", redirect: "error" });
    expect(storage.stores.get(WORD_LIST_CACHE)?.has(url)).toBe(true);
    await cacheWordLists([list(url)]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps a list only if its content hashes to the digest in its own name", async () => {
    const url = await nameFor("different\n");
    await cacheWordLists([list(url)]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(storage.stores.get(WORD_LIST_CACHE)?.size ?? 0).toBe(0);
  });

  it("never fetches a server-only list, a list without a URL, or a URL of another shape", async () => {
    const url = await nameFor(TEXT);
    await cacheWordLists([
      list(url, "serverOnly"),
      // A URL on a resource that doesn't say it is public is not followed.
      { ...list(url), distribution: undefined },
      list(undefined),
      list("https://evil.example/assets/dictionaries/enable-v1.0123456789abcdef.txt"),
      list("/assets/dictionaries/../../api/v1/me"),
      list("/assets/other/enable-v1.0123456789abcdef.txt"),
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps nothing and says nothing when the download fails", async () => {
    fetcher.mockRejectedValueOnce(new Error("offline"));
    const url = await nameFor(TEXT);
    await expect(cacheWordLists([list(url)])).resolves.toBeUndefined();
    fetcher.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    await expect(cacheWordLists([list(url)])).resolves.toBeUndefined();
    expect(storage.stores.get(WORD_LIST_CACHE)?.size ?? 0).toBe(0);
  });

  it("does nothing when there is no Cache Storage", async () => {
    vi.stubGlobal("caches", undefined);
    await cacheWordLists([list(await nameFor(TEXT))]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the three most recently added lists, but not at the cost of the game's own", async () => {
    const own = ["a", "b", "c", "d"];
    const urls: string[] = [];
    for (const id of own) {
      fetcher.mockResolvedValueOnce(new Response(`${id}\n`));
      urls.push(await nameFor(`${id}\n`, id));
    }
    // A game that itself uses four lists keeps all four while it is open.
    await cacheWordLists(own.map((id, i) => ({ ...list(urls[i]), id })));
    expect([...(storage.stores.get(WORD_LIST_CACHE)?.keys() ?? [])]).toEqual(urls);
    // Another game's list then pushes out the oldest of those, not itself.
    fetcher.mockResolvedValueOnce(new Response("e\n"));
    const other = await nameFor("e\n", "e");
    await cacheWordLists([{ ...list(other), id: "e" }]);
    expect([...(storage.stores.get(WORD_LIST_CACHE)?.keys() ?? [])]).toEqual([
      urls[2],
      urls[3],
      other,
    ]);
  });

  it("runs overlapping calls one after another, so they can't trim the same listing twice", async () => {
    const texts = ["p\n", "q\n", "r\n", "s\n", "t\n"];
    const urls = await Promise.all(texts.map((text, i) => nameFor(text, `l${String(i)}`)));
    vi.stubGlobal("fetch", (path: string) =>
      Promise.resolve(new Response(texts[urls.indexOf(path)] ?? "")),
    );
    await Promise.all(
      urls.map((url, i) => cacheWordLists([{ ...list(url), id: `l${String(i)}` }])),
    );
    expect([...(storage.stores.get(WORD_LIST_CACHE)?.keys() ?? [])]).toEqual(urls.slice(2));
  });

  it("still runs the next call after one that failed outright", async () => {
    const url = await nameFor(TEXT);
    const broken = {
      get distribution(): never {
        throw new Error("broken resource");
      },
    };
    await expect(cacheWordLists([broken as never])).rejects.toThrow("broken resource");
    await cacheWordLists([list(url)]);
    expect(storage.stores.get(WORD_LIST_CACHE)?.has(url)).toBe(true);
  });

  it("keeps the three most recently added lists", async () => {
    const names: string[] = [];
    for (const id of ["one", "two", "three", "four"]) {
      const text = `${id}\n`;
      fetcher.mockResolvedValueOnce(new Response(text));
      const url = await nameFor(text, id);
      names.push(url);
      await cacheWordLists([{ ...list(url), id }]);
    }
    expect([...(storage.stores.get(WORD_LIST_CACHE)?.keys() ?? [])]).toEqual(names.slice(1));
  });
});

describe("opening the game's word list for its board", () => {
  it("downloads, keeps and opens a public list, then opens it from the cache", async () => {
    const url = await nameFor(TEXT);
    const opened = await openWordList([list(url)]);
    expect(opened).toMatchObject({ id: "enable", version: 1 });
    expect(opened?.has("ab")).toBe(true);
    expect(opened?.has("bb")).toBe(false);
    expect(opened?.follows("a")).toBe(0b11);
    expect(storage.stores.get(WORD_LIST_CACHE)?.has(url)).toBe(true);
    const again = await openWordList([list(url)]);
    expect(again?.has("ba")).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("opens nothing that isn't public, or isn't served in the served shape", async () => {
    const url = await nameFor(TEXT);
    expect(await openWordList([list(url, "serverOnly")])).toBeNull();
    expect(await openWordList([{ ...list(url), distribution: undefined }])).toBeNull();
    expect(await openWordList([list(undefined)])).toBeNull();
    expect(await openWordList([list(url.replace("/assets/", "/other/"))])).toBeNull();
    expect(await openWordList([])).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("opens only the game's own list, never another resource after a server-only one", async () => {
    const url = await nameFor(TEXT);
    expect(await openWordList([list(url, "serverOnly"), { ...list(url), id: "other" }])).toBeNull();
  });

  it("opens nothing when the download fails", async () => {
    const url = await nameFor(TEXT);
    fetcher.mockRejectedValueOnce(new Error("offline"));
    expect(await openWordList([list(url)])).toBeNull();
    fetcher.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    expect(await openWordList([list(url)])).toBeNull();
  });

  it("opens nothing whose content doesn't hash to its name, downloaded or cached", async () => {
    const url = await nameFor("different\n");
    expect(await openWordList([list(url)])).toBeNull();
    // An entry changed in the cache after it was stored is refused too.
    const good = await nameFor(TEXT);
    const cache = await storage.open(WORD_LIST_CACHE);
    await cache.put(good, new Response("aa\nzz\n"));
    expect(await openWordList([list(good)])).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("opens nothing without Cache Storage", async () => {
    vi.stubGlobal("caches", undefined);
    expect(await openWordList([list(await nameFor(TEXT))])).toBeNull();
  });

  it("opens nothing that isn't a word list, and goes on after a failure", async () => {
    const url = await nameFor("aa\nab");
    fetcher.mockResolvedValueOnce(new Response("aa\nab"));
    expect(await openWordList([list(url)])).toBeNull();
    const broken = {
      get distribution(): never {
        throw new Error("broken resource");
      },
    };
    expect(await openWordList([broken as never])).toBeNull();
    expect(await openWordList([list(await nameFor(TEXT))])).not.toBeNull();
  });
});
