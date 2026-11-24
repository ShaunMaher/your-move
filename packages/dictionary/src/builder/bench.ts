/**
 * `pnpm --filter @your-move/dictionary bench`: measures what 03 §10 asks for on this machine, for
 * every built dictionary: the CPU cost of a load (reading the text and verifying its SHA-256) and of
 * a lookup. Run after the build; the numbers recorded in README.md come from it.
 */
import { readFileSync } from "node:fs";
import { cpuUsage, memoryUsage } from "node:process";
import { fileURLToPath } from "node:url";

import { sha256TextHex } from "../hash.js";
import { createWordList } from "../lookup.js";
import { parseIndex } from "../manifest.js";
import { createDictionaryProvider } from "../provider.js";

const generated = fileURLToPath(new URL("../../generated", import.meta.url));
const index = parseIndex(JSON.parse(readFileSync(`${generated}/index.json`, "utf8")));

/** CPU milliseconds (user + system) spent in `run`. */
async function cpuMs(run: () => Promise<unknown>): Promise<number> {
  const start = cpuUsage();
  await run();
  const used = cpuUsage(start);
  return (used.user + used.system) / 1000;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

for (const manifest of index.dictionaries) {
  const file = `${generated}/${manifest.id}/words.txt`;
  const rssBefore = memoryUsage().rss;
  const text = readFileSync(file, "latin1");
  const rssLoaded = memoryUsage().rss - rssBefore;

  // Load: read the file and verify it, through the provider, each time in a fresh provider.
  const loads: number[] = [];
  const hashes: number[] = [];
  for (let run = 0; run < 7; run += 1) {
    const provider = createDictionaryProvider({
      index,
      loadText: () => Promise.resolve(readFileSync(file, "latin1")),
    });
    loads.push(await cpuMs(() => provider.load(manifest.id)));
    hashes.push(await cpuMs(() => sha256TextHex(text)));
  }

  // Lookups: half present, half absent one-letter near misses (a near miss that happens to be a
  // word is rerolled), from a fixed pseudo-random sequence.
  const words = text.slice(0, -1).split("\n");
  const list = createWordList(manifest.id, manifest.version, text);
  let seed = 12345;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed % n;
  };
  const nearMiss = (): string => {
    for (;;) {
      const word = words[next(words.length)] ?? "";
      const at = next(word.length);
      const miss = word.slice(0, at) + String.fromCharCode(97 + next(26)) + word.slice(at + 1);
      if (!list.has(miss)) return miss;
    }
  };
  const queries = Array.from({ length: 200_000 }, (_, i) =>
    i % 2 === 0 ? (words[next(words.length)] ?? "") : nearMiss(),
  );
  const perLookup: number[] = [];
  for (let round = 0; round < 6; round += 1) {
    const ms = await cpuMs(() => {
      for (const query of queries) list.has(query);
      return Promise.resolve();
    });
    if (round > 0) perLookup.push((ms * 1e6) / queries.length); // the first round warms up
  }
  const lookupNs = median(perLookup);

  console.log(
    `dictionary ${manifest.id} v${String(manifest.version)} (${String(manifest.bytes)} bytes)`,
  );
  console.log(
    `  load, read + SHA-256 verify: median ${median(loads).toFixed(1)} ms CPU over 7 runs`,
  );
  console.log(`  of which SHA-256: median ${median(hashes).toFixed(1)} ms CPU`);
  console.log(
    `  lookup: median ${lookupNs.toFixed(0)} ns CPU over ${String(queries.length)} lookups x 5`,
  );
  console.log(`  derived: a play's 8 lookups ≈ ${((8 * lookupNs) / 1000).toFixed(1)} µs CPU`);
  console.log(`  resident memory added by reading the list: ${(rssLoaded / 1e6).toFixed(1)} MB`);
}
