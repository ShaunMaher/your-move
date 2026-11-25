import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cacheWordLists, WORD_LIST_CACHE } from "./word-lists.js";

const TEXT = "aa\nab\nba\n";

async function nameFor(text: string, id = "enable"): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  return `/assets/dictionaries/${id}-v1.${hex}.txt`;
}

/** An in-memory Cache Storage with insertion-ordered keys, as the real one's `keys()` is. */
function fakeStorage() {
  const stores = new Map<string, Map<string, Response>>();
  return {
    stores,
    open: (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return Promise.resolve({
        match: (path: string) => Promise.resolve(store.get(path)?.clone()),
        put: (path: string, response: Response) => {
          store.delete(path);
          store.set(path, response);
          return Promise.resolve();
        },
        keys: () =>
          Promise.resolve([...store.keys()].map((path) => new Request(`http://localhost${path}`))),
        delete: (request: Request) => Promise.resolve(store.delete(new URL(request.url).pathname)),
      });
    },
  };
}

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
    fetcher.mockImplementation((path: string) =>
      Promise.resolve(new Response(texts[urls.indexOf(path)] ?? "")),
    );
    await Promise.all(
      urls.map((url, i) => cacheWordLists([{ ...list(url), id: `l${String(i)}` }])),
    );
    expect([...(storage.stores.get(WORD_LIST_CACHE)?.keys() ?? [])]).toEqual(urls.slice(2));
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
