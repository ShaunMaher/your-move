import { describe, expect, it } from "vitest";

import { manifestSchema, parseIndex, toResourceMeta } from "./manifest.js";
import { manifestFor } from "./test-support.js";

const ONE = manifestFor("one", "aa\nab\n");

describe("parseIndex", () => {
  it("accepts the build's index", () => {
    const index = { dictionaries: [ONE, manifestFor("two", "zz\n")] };
    expect(parseIndex(JSON.parse(JSON.stringify(index)))).toStrictEqual(index);
  });

  it.each<[string, unknown]>([
    ["not an object", "enable"],
    ["a duplicate id", { dictionaries: [ONE, ONE] }],
    ["an unknown field", { dictionaries: [], extra: true }],
    ["an upload id", { dictionaries: [{ ...ONE, id: "u_1234" }] }],
    ["an id with capitals", { dictionaries: [{ ...ONE, id: "One" }] }],
    [
      "a plain-http source",
      { dictionaries: [{ ...ONE, sourceUrl: "http://example.org/one.txt" }] },
    ],
    ["a short hash", { dictionaries: [{ ...ONE, sha256: "abc" }] }],
    ["a server-only distribution", { dictionaries: [{ ...ONE, distribution: "serverOnly" }] }],
    ["an alphabet entry that isn't one letter", { dictionaries: [{ ...ONE, alphabet: ["ab"] }] }],
    ["a missing field", { dictionaries: [{ ...ONE, bytes: undefined }] }],
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

  it("validates a single manifest with the same schema", () => {
    expect(manifestSchema.safeParse(ONE).success).toBe(true);
  });
});
