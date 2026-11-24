/**
 * The committed built-in dictionaries, built for real: ENABLE (words §9.2) matches its recorded
 * checksum and its expected contents, and lookups over the whole list are correct.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { checkWordList, isWord } from "../format.js";
import { hasWord } from "../lookup.js";
import { buildDictionary, parseEdits, type BuiltDictionary } from "./build.js";

const PACKAGE = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string): string => readFileSync(`${PACKAGE}/${path}`, "utf8");

/**
 * The SHA-256 of each released version's built word list. A change to `source.txt`,
 * `additions.txt`, `removals.txt` or `removals-global.txt` changes the list, which must bump the
 * version in `meta.json` (words §9.4) and add its hash here.
 */
const RELEASED: Record<number, string> = {
  1: "6cd2880601e4ccc32b53b735de08e8bf233d2d87890dad378a4a023872f6f59d",
};

async function buildEnable(): Promise<BuiltDictionary> {
  const dir = "dictionaries/enable";
  return buildDictionary(
    {
      meta: JSON.parse(read(`${dir}/meta.json`)) as unknown,
      source: readFileSync(`${PACKAGE}/${dir}/source.txt`),
      additions: read(`${dir}/additions.txt`),
      removals: read(`${dir}/removals.txt`),
    },
    read("removals-global.txt"),
  );
}

describe("ENABLE (words §9.2)", () => {
  let built: BuiltDictionary;
  beforeAll(async () => {
    built = await buildEnable();
  });
  const source = read("dictionaries/enable/source.txt").split("\n");
  const removals = parseEdits("removals.txt", read("dictionaries/enable/removals.txt"));
  const global = parseEdits("removals-global.txt", read("removals-global.txt"));

  it("is the released version, public domain and English, with the expected list", () => {
    const { manifest } = built;
    expect(manifest.id).toBe("enable");
    expect(manifest.language).toBe("en");
    expect(manifest.licence).toBe("Public domain");
    expect(RELEASED[manifest.version]).toBe(manifest.sha256);
    expect(manifest.alphabet).toStrictEqual(
      Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)),
    );
  });

  it("keeps every upstream word of length 2..15 except the removals", () => {
    const kept = source.filter(isWord).filter((word) => !removals.includes(word));
    expect(source).toHaveLength(172_820);
    expect(built.manifest.skipped).toStrictEqual({
      length: 172_820 - source.filter(isWord).length,
      characters: 0,
    });
    expect(built.manifest.wordCount).toBe(kept.length);
    expect(checkWordList(built.text)).toMatchObject({ ok: true, wordCount: kept.length });
    for (const word of kept) {
      if (!hasWord(built.text, word))
        throw new Error(`lookup misses a kept word at index ${String(kept.indexOf(word))}`);
    }
  });

  it("finds no removed word, no word over 15 letters and no non-word", () => {
    for (const word of [...removals, ...global]) expect(hasWord(built.text, word)).toBe(false);
    const long = source.find((word) => word.length > 15);
    expect(long).toBeDefined();
    expect(hasWord(built.text, long!)).toBe(false);
    for (const word of ["a", "qi", "zzz", "aaa", "zyzzyvaz", "Aa"])
      expect(hasWord(built.text, word)).toBe(false);
  });

  it("finds familiar words at both ends and in the middle", () => {
    for (const word of ["aa", "aah", "quiz", "jinx", "oxygen", "zyzzyva", "zyzzyvas"]) {
      expect(hasWord(built.text, word)).toBe(true);
    }
  });

  it("keeps every global removal in its own removals.txt too (words §9.1)", () => {
    expect(global.filter((word) => !removals.includes(word))).toStrictEqual([]);
  });
});
