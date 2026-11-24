import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseIndex } from "../manifest.js";
import { sha256Hex } from "./build.js";
import { buildAll } from "./files.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dictionary-build-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes `dictionaries/<name>/` with meta.json's hash computed for `source`. */
async function addDictionary(
  name: string,
  source: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  const target = join(dir, "dictionaries", name);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "source.txt"), source);
  writeFileSync(join(target, "additions.txt"), "");
  writeFileSync(join(target, "removals.txt"), "");
  writeFileSync(
    join(target, "meta.json"),
    JSON.stringify({
      id: name,
      version: 1,
      name: name.toUpperCase(),
      description: "A test list.",
      language: "en",
      licence: "CC0-1.0",
      sourceUrl: `https://example.org/${name}.txt`,
      sha256: await sha256Hex(new TextEncoder().encode(source)),
      ...meta,
    }),
  );
}

describe("buildAll", () => {
  it("writes each word list, its compressed copies, its manifest and the index", async () => {
    writeFileSync(join(dir, "removals-global.txt"), "bb\n");
    await addDictionary("one", "aa\nbb\ncc\n");
    await addDictionary("two", "zz\n");
    const out = join(dir, "generated");
    mkdirSync(join(out, "stale"), { recursive: true });

    const reports = await buildAll(dir, out);

    expect(reports.map((report) => [report.id, report.words, report.bytes])).toStrictEqual([
      ["one", 2, 6],
      ["two", 1, 3],
    ]);
    const text = readFileSync(join(out, "one", "words.txt"), "utf8");
    expect(text).toBe("aa\ncc\n");
    expect(gunzipSync(readFileSync(join(out, "one", "words.txt.gz"))).toString("utf8")).toBe(text);
    expect(
      brotliDecompressSync(readFileSync(join(out, "one", "words.txt.br"))).toString("utf8"),
    ).toBe(text);
    const index = parseIndex(JSON.parse(readFileSync(join(out, "index.json"), "utf8")));
    expect(index.dictionaries.map((manifest) => manifest.id)).toStrictEqual(["one", "two"]);
    expect(JSON.parse(readFileSync(join(out, "two", "manifest.json"), "utf8"))).toStrictEqual(
      index.dictionaries[1],
    );
    expect(() => readFileSync(join(out, "stale"))).toThrow();
  });

  it("refuses a dictionary whose id isn't its directory name", async () => {
    writeFileSync(join(dir, "removals-global.txt"), "");
    await addDictionary("one", "aa\n", { id: "uno" });
    await expect(buildAll(dir, join(dir, "generated"))).rejects.toThrow(
      /dictionaries\/one: .*directory name/u,
    );
  });

  it("names the dictionary when a file is missing or broken", async () => {
    writeFileSync(join(dir, "removals-global.txt"), "");
    await addDictionary("one", "aa\n");
    rmSync(join(dir, "dictionaries", "one", "removals.txt"));
    await expect(buildAll(dir, join(dir, "generated"))).rejects.toThrow(
      /dictionaries\/one: .*removals\.txt/u,
    );
    await addDictionary("one", "aa\n");
    writeFileSync(join(dir, "dictionaries", "one", "meta.json"), "{");
    await expect(buildAll(dir, join(dir, "generated"))).rejects.toThrow(/dictionaries\/one: /u);
  });

  it("refuses an empty registry and leaves the output alone when a build fails", async () => {
    writeFileSync(join(dir, "removals-global.txt"), "");
    mkdirSync(join(dir, "dictionaries"));
    const out = join(dir, "generated");
    mkdirSync(out);
    writeFileSync(join(out, "keep.txt"), "x");
    await expect(buildAll(dir, out)).rejects.toThrow(/holds no dictionary/u);
    await addDictionary("one", "aa\n", { sha256: "0".repeat(64) });
    await expect(buildAll(dir, out)).rejects.toThrow(/sha256/u);
    expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("x");
  });
});
