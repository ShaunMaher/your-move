/**
 * Every committed built-in dictionary (`dictionaries/<id>/`), built for real: it matches the hash
 * recorded for its version, keeps exactly the upstream words it should, removes what it should,
 * and lookups over the whole list are correct. ENABLE (words §9.2) also gets its known numbers.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { checkWordList, isWord } from "../format.js";
import { hasWord } from "../lookup.js";
import { buildDictionary, parseEdits, type BuiltDictionary } from "./build.js";

const PACKAGE = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string): string => readFileSync(`${PACKAGE}/${path}`, "utf8");

/**
 * The SHA-256 of each version's built word list (`wordsSha256`), per dictionary. A change to
 * `source.txt`, `additions.txt`, `removals.txt` or `removals-global.txt` changes the list, which
 * must bump the version in `meta.json` (words §9.4) and add the new version's hash here.
 *
 * Existing entries must never be edited or removed: a version, once recorded, names one list
 * forever. (Tests can only check the current version against a build, since older sources are
 * gone; CODEOWNERS review guards the rest.)
 */
const RELEASED: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  enable: {
    1: "6cd2880601e4ccc32b53b735de08e8bf233d2d87890dad378a4a023872f6f59d",
    2: "36c2c06464b7eecf7f8093b16a47725bf8e09895049f53fe7132cc8e8f6adb94",
  },
};

/** The licences the licensing gate admits for word lists (words §9.1, docs/licences.md). */
const LIST_LICENCES = new Set(["Public domain", "CC0-1.0", "Unlicense", "MIT", "BSD-2-Clause"]);

const IDS = readdirSync(`${PACKAGE}/dictionaries`, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const GLOBAL = parseEdits("removals-global.txt", read("removals-global.txt"));

it("has a recorded hash history for every dictionary, and no history for a missing one", () => {
  expect(IDS.length).toBeGreaterThan(0);
  expect(Object.keys(RELEASED).sort()).toStrictEqual(IDS);
});

describe.each(IDS)("built-in dictionary %s (words §9.1)", (id) => {
  const dir = `dictionaries/${id}`;
  const source = read(`${dir}/source.txt`)
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const additions = parseEdits("additions.txt", read(`${dir}/additions.txt`));
  const removals = parseEdits("removals.txt", read(`${dir}/removals.txt`));
  let built: BuiltDictionary;

  beforeAll(async () => {
    built = await buildDictionary(
      {
        meta: JSON.parse(read(`${dir}/meta.json`)) as unknown,
        source: readFileSync(`${PACKAGE}/${dir}/source.txt`),
        additions: read(`${dir}/additions.txt`),
        removals: read(`${dir}/removals.txt`),
      },
      read("removals-global.txt"),
    );
  });

  it("is the recorded list for its version, with versions 1..current recorded", () => {
    const history = RELEASED[id] ?? {};
    expect(history[built.manifest.version]).toBe(built.manifest.wordsSha256);
    expect(Object.keys(history).map(Number)).toStrictEqual(
      Array.from({ length: built.manifest.version }, (_, i) => i + 1),
    );
  });

  it("is under a licence the licensing gate admits", () => {
    expect(LIST_LICENCES.has(built.manifest.licence)).toBe(true);
  });

  it("keeps every upstream word of length 2..15 plus the additions, except the removals", () => {
    const removed = new Set([...removals, ...GLOBAL]);
    const kept = [...source.filter(isWord), ...additions].filter((word) => !removed.has(word));
    expect(built.manifest.wordCount).toBe(new Set(kept).size);
    expect(checkWordList(built.text)).toMatchObject({ ok: true, wordCount: new Set(kept).size });
    for (const word of kept) {
      if (!hasWord(built.text, word)) {
        throw new Error(`lookup misses a kept word at index ${String(kept.indexOf(word))}`);
      }
    }
    for (const word of removed) expect(hasWord(built.text, word)).toBe(false);
  });

  it("lists in removals.txt every global removal its source contains (words §9.1)", () => {
    const inSource = new Set(source);
    expect(GLOBAL.filter((word) => inSource.has(word) && !removals.includes(word))).toStrictEqual(
      [],
    );
  });
});

describe("ENABLE (words §9.2)", () => {
  let built: BuiltDictionary;
  beforeAll(async () => {
    const dir = "dictionaries/enable";
    built = await buildDictionary(
      {
        meta: JSON.parse(read(`${dir}/meta.json`)) as unknown,
        source: readFileSync(`${PACKAGE}/${dir}/source.txt`),
        additions: read(`${dir}/additions.txt`),
        removals: read(`${dir}/removals.txt`),
      },
      read("removals-global.txt"),
    );
  });

  it("is public domain English, 172,820 upstream words cut to 168,465", () => {
    expect(built.manifest.language).toBe("en");
    expect(built.manifest.licence).toBe("Public domain");
    expect(built.manifest.skipped).toStrictEqual({ length: 4272, characters: 0 });
    expect(built.manifest.wordCount).toBe(168_465);
    expect(built.manifest.alphabet).toStrictEqual(
      Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)),
    );
  });

  it("finds familiar words at both ends and in the middle, and no non-word", () => {
    for (const word of ["aa", "aah", "quiz", "jinx", "oxygen", "zyzzyva", "zyzzyvas"]) {
      expect(hasWord(built.text, word)).toBe(true);
    }
    for (const word of ["a", "qi", "zzz", "aaa", "zyzzyvaz", "Aa", "uncharacteristically"]) {
      expect(hasWord(built.text, word)).toBe(false);
    }
  });
});
