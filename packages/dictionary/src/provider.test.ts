import { describe, expect, it } from "vitest";

import { formatWordList } from "./format.js";
import type { DictionaryManifest } from "./manifest.js";
import { createDictionaryProvider, DictionaryMismatchError } from "./provider.js";
import { manifestFor } from "./test-support.js";

const TEXTS: Record<string, string> = {
  one: formatWordList(["aa", "cat", "dog"]),
  two: formatWordList(["zz"]),
};
const INDEX = {
  dictionaries: [manifestFor("one", TEXTS["one"]!), manifestFor("two", TEXTS["two"]!, 4)],
};

/** A loader that counts its calls and can be told to fail or return the wrong text. */
function loader(behaviour: { fail?: number; wrong?: boolean } = {}) {
  const calls: string[] = [];
  let failures = behaviour.fail ?? 0;
  const loadText = (manifest: DictionaryManifest): Promise<string> => {
    calls.push(manifest.id);
    if (failures > 0) {
      failures -= 1;
      return Promise.reject(new Error("asset unavailable"));
    }
    const text = TEXTS[manifest.id] ?? "";
    return Promise.resolve(behaviour.wrong === true ? `${text}zzz\n` : text);
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

  it("refuses a word list that doesn't match its manifest", async () => {
    const provider = createDictionaryProvider({ index: INDEX, ...loader({ wrong: true }) });
    await expect(provider.load("one")).rejects.toBeInstanceOf(DictionaryMismatchError);
  });
});
