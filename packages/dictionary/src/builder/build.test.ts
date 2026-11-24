import { describe, expect, it } from "vitest";

import { hasWord } from "../lookup.js";
import {
  BuildError,
  buildDictionary,
  parseEdits,
  sha256Hex,
  type DictionarySources,
} from "./build.js";

const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

/** A dictionary directory's files, with meta.json's hash computed for `source`. */
async function sources(
  source: string,
  edits: { additions?: string; removals?: string; meta?: Record<string, unknown> } = {},
): Promise<DictionarySources> {
  const bytes = encode(source);
  return {
    meta: {
      id: "tiny",
      version: 2,
      name: "Tiny",
      description: "A test list.",
      language: "en",
      licence: "CC0-1.0",
      sourceUrl: "https://example.org/tiny.txt",
      sha256: await sha256Hex(bytes),
      ...edits.meta,
    },
    source: bytes,
    additions: edits.additions ?? "",
    removals: edits.removals ?? "",
  };
}

describe("sha256Hex", () => {
  it("hashes like every other SHA-256", async () => {
    await expect(sha256Hex(encode("abc"))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("parseEdits", () => {
  it.each([
    ["", []],
    ["ab\n", ["ab"]],
    ["ab\ncd\n", ["ab", "cd"]],
  ])("reads %j", (text, words) => {
    expect(parseEdits("x.txt", text)).toStrictEqual(words);
  });

  it.each([
    ["ab", /last line must end with a newline/u],
    ["ab\n\n", /line 2: not a word/u],
    ["ab\n# why\n", /line 2: not a word/u],
    ["Ab\n", /line 1: not a word/u],
    ["a\n", /line 1: not a word/u],
    ["cd\nab\n", /line 2: lines must be sorted/u],
    ["ab\nab\n", /line 2: lines must be sorted/u],
  ])("refuses %j", (text, message) => {
    expect(() => parseEdits("x.txt", text)).toThrow(message);
  });
});

describe("buildDictionary (words §9.1)", () => {
  it("keeps a–z words of length 2..15, sorted, and counts what it drops", async () => {
    const source = "zebra\r\nab\nA\nCity\na\nabcdefghijklmnop\nabcdefghijklmno\n\ndon't\nab\n";
    const built = await buildDictionary(await sources(source), "");
    expect(built.text).toBe("ab\nabcdefghijklmno\nzebra\n");
    expect(built.manifest.skipped).toStrictEqual({ length: 2, characters: 3 });
    expect(built.manifest.wordCount).toBe(3);
  });

  it("records the metadata, the alphabet, the hashes and the size", async () => {
    const input = await sources("bad\ncab\n");
    const built = await buildDictionary(input, "");
    expect(built.manifest).toStrictEqual({
      id: "tiny",
      version: 2,
      name: "Tiny",
      description: "A test list.",
      language: "en",
      licence: "CC0-1.0",
      sourceUrl: "https://example.org/tiny.txt",
      sourceSha256: (input.meta as { sha256: string }).sha256,
      distribution: "public",
      wordCount: 2,
      alphabet: ["a", "b", "c", "d"],
      sha256: await sha256Hex(encode("bad\ncab\n")),
      bytes: 8,
      skipped: { length: 0, characters: 0 },
    });
  });

  it("applies additions, removals and the global removals", async () => {
    const built = await buildDictionary(
      await sources("aa\nbb\ncc\ndd\n", { additions: "ee\nqi\n", removals: "bb\n" }),
      "cc\nzz\n",
    );
    expect(built.text).toBe("aa\ndd\nee\nqi\n");
    for (const word of ["aa", "dd", "ee", "qi"]) expect(hasWord(built.text, word)).toBe(true);
    for (const word of ["bb", "cc", "zz"]) expect(hasWord(built.text, word)).toBe(false);
  });

  it.each<[string, () => Promise<DictionarySources>, string, RegExp]>([
    [
      "a source that doesn't match its hash",
      async () => ({ ...(await sources("aa\n")), source: encode("aa\nbb\n") }),
      "",
      /doesn't match the sha256/u,
    ],
    [
      "invalid metadata",
      () => sources("aa\n", { meta: { id: "Tiny", extra: 1 } }),
      "",
      /meta\.json is invalid \(.*\bid\b/u,
    ],
    [
      "a plain-http source URL",
      () => sources("aa\n", { meta: { sourceUrl: "http://example.org" } }),
      "",
      /sourceUrl/u,
    ],
    [
      "a source that isn't UTF-8",
      async () => {
        const bytes = new Uint8Array([0x61, 0x61, 0x0a, 0xff, 0x0a]);
        return {
          ...(await sources("")),
          source: bytes,
          meta: { ...((await sources("")).meta as object), sha256: await sha256Hex(bytes) },
        };
      },
      "",
      /not valid UTF-8/u,
    ],
    [
      "an addition already in the source",
      () => sources("aa\nbb\n", { additions: "bb\n" }),
      "",
      /additions.txt line 1: already/u,
    ],
    [
      "a removal not in the source",
      () => sources("aa\nbb\n", { removals: "cc\n" }),
      "",
      /removals.txt line 1: not a word of source/u,
    ],
    [
      "a removal of an addition",
      () => sources("aa\n", { additions: "bb\n", removals: "bb\n" }),
      "",
      /removals.txt line 1/u,
    ],
    ["an invalid global removal", () => sources("aa\n"), "Bb\n", /removals-global.txt line 1/u],
    [
      "a list left empty",
      () => sources("aa\n", { removals: "aa\n" }),
      "",
      /built list is invalid \(EMPTY\)/u,
    ],
  ])("refuses %s", async (_name, input, global, message) => {
    const promise = buildDictionary(await input(), global);
    await expect(promise).rejects.toBeInstanceOf(BuildError);
    await expect(promise).rejects.toThrow(message);
  });

  it("never names a word in an error (the removals are slurs)", async () => {
    await expect(
      buildDictionary(await sources("aa\n", { removals: "secretword\n" }), ""),
    ).rejects.not.toThrow(/secretword/u);
  });
});
