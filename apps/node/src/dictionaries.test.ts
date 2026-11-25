import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DictionariesError, nodeDictionaries } from "./dictionaries.js";

/** The dictionary package's served layout, built by `pnpm build`. */
const SERVED = fileURLToPath(
  new URL("../../../packages/dictionary/generated/served", import.meta.url),
);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "node-dictionaries-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("nodeDictionaries", () => {
  it("reads the index and loads a word list by its served name", async () => {
    const dictionaries = nodeDictionaries(SERVED);
    const enable = dictionaries.index.dictionaries.find((manifest) => manifest.id === "enable");
    expect(enable).toBeDefined();
    if (enable === undefined) return;
    const text = await dictionaries.loadText(enable);
    expect(text.length).toBe(enable.bytes);
  });

  it("refuses a directory without an index, naming no contents", () => {
    expect(() => nodeDictionaries(dir)).toThrow(DictionariesError);
  });

  it("refuses an invalid index", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.json"), '{"dictionaries": "nope"}');
    expect(() => nodeDictionaries(dir)).toThrow(DictionariesError);
  });
});
