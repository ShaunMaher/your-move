import { describe, expect, it } from "vitest";

import { manifestSchema, parseIndex, toResourceMeta } from "./manifest.js";
import { manifestFor } from "./test-support.js";

const ONE = await manifestFor("one", "aa\nab\n");
const TWO = await manifestFor("two", "zz\n");

describe("parseIndex", () => {
  it("accepts the build's index", () => {
    const index = { dictionaries: [ONE, TWO], globalRemovals: ["xx", "yy"] };
    expect(parseIndex(JSON.parse(JSON.stringify(index)))).toStrictEqual(index);
  });

  it.each<[string, unknown]>([
    ["not an object", "enable"],
    ["a duplicate id", { dictionaries: [ONE, ONE], globalRemovals: [] }],
    ["an unknown field", { dictionaries: [], globalRemovals: [], extra: true }],
    ["no global removals", { dictionaries: [] }],
    ["a global removal that isn't a word", { dictionaries: [], globalRemovals: ["X"] }],
    ["an upload id", { dictionaries: [{ ...ONE, id: "u_1234" }], globalRemovals: [] }],
    ["an id with capitals", { dictionaries: [{ ...ONE, id: "One" }], globalRemovals: [] }],
    [
      "a plain-http source",
      { dictionaries: [{ ...ONE, sourceUrl: "http://example.org/one.txt" }], globalRemovals: [] },
    ],
    ["a short source hash", { dictionaries: [{ ...ONE, sha256: "abc" }], globalRemovals: [] }],
    ["a short list hash", { dictionaries: [{ ...ONE, wordsSha256: "abc" }], globalRemovals: [] }],
    [
      "a server-only distribution",
      { dictionaries: [{ ...ONE, distribution: "serverOnly" }], globalRemovals: [] },
    ],
    [
      "an alphabet entry that isn't one letter",
      { dictionaries: [{ ...ONE, alphabet: ["ab"] }], globalRemovals: [] },
    ],
    ["a missing field", { dictionaries: [{ ...ONE, bytes: undefined }], globalRemovals: [] }],
  ])("refuses %s", (_name, json) => {
    expect(() => parseIndex(json)).toThrow();
  });
});

describe("toResourceMeta", () => {
  it("gives the catalog metadata only, never contents or hashes (08 T22)", () => {
    expect(toResourceMeta(ONE)).toStrictEqual({
      kind: "dictionary",
      id: "one",
      version: 1,
      name: "ONE",
      language: "en",
      alphabet: ["a", "b"],
      distribution: "public",
      source: "builtin",
    });
  });

  it("gives a frozen copy of the alphabet, never the manifest's own array", () => {
    const meta = toResourceMeta(ONE);
    expect(meta.alphabet).not.toBe(ONE.alphabet);
    expect(Object.isFrozen(meta.alphabet)).toBe(true);
  });

  it("validates a single manifest with the same schema", () => {
    expect(manifestSchema.safeParse(ONE).success).toBe(true);
  });
});
