import { describe, expect, it } from "vitest";

import { formatWordList } from "./format.js";
import { sha256TextHex } from "./hash.js";
import { WordListFormatError } from "./lookup.js";
import type { DictionaryManifest } from "./manifest.js";
import { createDictionaryProvider, DictionaryMismatchError } from "./provider.js";
import { manifestFor } from "./test-support.js";

const TEXTS: Record<string, string> = {
  one: formatWordList(["aa", "cat", "dog"]),
  two: formatWordList(["zz"]),
};
const INDEX = {
  dictionaries: [
    await manifestFor("one", TEXTS["one"]!),
    await manifestFor("two", TEXTS["two"]!, 4),
  ],
  globalRemovals: [],
};

/** A loader that counts its calls, and can fail first or serve other text. */
function loader(behaviour: { fail?: number; serve?: (text: string) => string } = {}) {
  const calls: string[] = [];
  let failures = behaviour.fail ?? 0;
  const loadText = (manifest: DictionaryManifest): Promise<string> => {
    calls.push(manifest.id);
    if (failures > 0) {
      failures -= 1;
      return Promise.reject(new Error("asset unavailable"));
    }
    const text = TEXTS[manifest.id] ?? "";
    return Promise.resolve(behaviour.serve ? behaviour.serve(text) : text);
  };
  return { calls, loadText };
}

describe("DictionaryProvider (03 §10)", () => {
  it("lists every built-in dictionary's metadata without loading any", () => {
    const { calls, loadText } = loader();
    const provider = createDictionaryProvider({ index: INDEX, loadText });
    expect(provider.catalog().map((meta) => [meta.id, meta.version, meta.source])).toStrictEqual([
      ["one", 1, "builtin"],
      ["two", 4, "builtin"],
    ]);
    expect(Object.isFrozen(provider.catalog())).toBe(true);
    expect(calls).toStrictEqual([]);
  });

  it("loads a dictionary on first use and looks words up in it", async () => {
    const provider = createDictionaryProvider({ index: INDEX, ...loader() });
    const one = await provider.load("one");
    expect(one?.id).toBe("one");
    expect(one?.version).toBe(1);
    expect(one?.has("cat")).toBe(true);
    expect(one?.has("cow")).toBe(false);
  });

  it("answers undefined for an unknown id without calling the loader", async () => {
    const { calls, loadText } = loader();
    const provider = createDictionaryProvider({ index: INDEX, loadText });
    await expect(provider.load("three")).resolves.toBeUndefined();
    await expect(provider.load("constructor")).resolves.toBeUndefined();
    expect(calls).toStrictEqual([]);
  });

  it("loads each dictionary once, even for concurrent first uses", async () => {
    const { calls, loadText } = loader();
    const provider = createDictionaryProvider({ index: INDEX, loadText });
    const [a, b] = await Promise.all([provider.load("one"), provider.load("one")]);
    const c = await provider.load("one");
    await provider.load("two");
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(calls).toStrictEqual(["one", "two"]);
  });

  it("forgets a failed load, so the next use retries", async () => {
    const { calls, loadText } = loader({ fail: 1 });
    const provider = createDictionaryProvider({ index: INDEX, loadText });
    await expect(provider.load("one")).rejects.toThrow("asset unavailable");
    expect((await provider.load("one"))?.has("dog")).toBe(true);
    expect(calls).toStrictEqual(["one", "one"]);
  });

  it.each<[string, (text: string) => string]>([
    ["a longer list", (text) => `${text}zzz\n`],
    ["a truncated list", (text) => text.slice(0, -1)],
    // A stale list of exactly the same size: only the hash tells them apart (M1b review P-1).
    ["a different list of the same size", () => formatWordList(["ab", "cow", "dog"])],
  ])("refuses %s, and retries on the next use", async (_name, serve) => {
    const provider = createDictionaryProvider({ index: INDEX, ...loader({ serve }) });
    await expect(provider.load("one")).rejects.toBeInstanceOf(DictionaryMismatchError);
    await expect(provider.load("one")).rejects.toBeInstanceOf(DictionaryMismatchError);
  });

  it("refuses a list without its final newline even if its manifest describes it", async () => {
    const text = "aa\ncat";
    const manifest = { ...(await manifestFor("one", "aa\ncat\n")), bytes: text.length };
    const index = {
      dictionaries: [{ ...manifest, wordsSha256: await sha256TextHex(text) }],
      globalRemovals: [],
    };
    const provider = createDictionaryProvider({ index, loadText: () => Promise.resolve(text) });
    await expect(provider.load("one")).rejects.toBeInstanceOf(WordListFormatError);
  });
});
