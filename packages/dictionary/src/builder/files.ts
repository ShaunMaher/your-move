/**
 * The dictionary build's file side (docs/spec/games/words.md §9.1): reads every
 * `dictionaries/<id>/` directory, builds it, and writes `generated/`:
 *
 * - `<id>/words.txt`: the compact word list the server looks words up in;
 * - `<id>/words.txt.gz` and `<id>/words.txt.br`: the same, compressed, for clients;
 * - `<id>/manifest.json`: its metadata, alphabet, hash and size;
 * - `index.json`: every manifest and the global removals, which the runtime parses with
 *   `parseIndex`;
 * - `served/`: what the runtimes publish (words §9.4): each word list (and its compressed copies)
 *   under its versioned, hashed `servedFileName`, and `index.json`. The server reads the lists from
 *   there and clients download them by `servedPath`.
 *
 * `generated/` is rebuilt from scratch each time and never committed.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

import { type DictionaryIndex, servedFileName } from "../manifest.js";
import { BuildError, buildDictionary, parseEdits, type BuiltDictionary } from "./build.js";

/** One built dictionary's output files, with their sizes in bytes. */
export interface BuildReport {
  readonly id: string;
  readonly words: number;
  readonly bytes: number;
  readonly gzipBytes: number;
  readonly brotliBytes: number;
}

function readText(file: string): string {
  return readFileSync(file, "utf8");
}

/** Reads and builds `dictionaries/<id>/`; the directory's name must be the dictionary's id. */
async function buildDirectory(
  dir: string,
  id: string,
  globalRemovals: string,
): Promise<BuiltDictionary> {
  let built: BuiltDictionary;
  try {
    built = await buildDictionary(
      {
        meta: JSON.parse(readText(join(dir, "meta.json"))) as unknown,
        source: readFileSync(join(dir, "source.txt")),
        additions: readText(join(dir, "additions.txt")),
        removals: readText(join(dir, "removals.txt")),
      },
      globalRemovals,
    );
  } catch (error) {
    // Build tooling over our own files: a missing file or bad JSON is reported as it is.
    throw new BuildError(
      `dictionaries/${id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (built.manifest.id !== id) {
    throw new BuildError(`dictionaries/${id}: meta.json's id must be the directory name`);
  }
  return built;
}

/** Writes one dictionary's files under `outDir/<id>/`. */
function writeDictionary(outDir: string, built: BuiltDictionary): BuildReport {
  const dir = join(outDir, built.manifest.id);
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from(built.text, "ascii");
  const gzip = gzipSync(bytes, { level: 9 });
  const brotli = brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  });
  writeFileSync(join(dir, "words.txt"), bytes);
  writeFileSync(join(dir, "words.txt.gz"), gzip);
  writeFileSync(join(dir, "words.txt.br"), brotli);
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(built.manifest, null, 2)}\n`);
  return {
    id: built.manifest.id,
    words: built.manifest.wordCount,
    bytes: bytes.length,
    gzipBytes: gzip.length,
    brotliBytes: brotli.length,
  };
}

/** This package's own directory, where `dictionaries/` and `removals-global.txt` live. */
const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Builds one built-in dictionary in memory, writing nothing: for tests elsewhere in the
 * workspace (e.g. the words engine's property tests) that need the real list without a build
 * step.
 */
export async function buildBuiltin(id: string): Promise<BuiltDictionary> {
  const globalRemovals = readText(join(PACKAGE_DIR, "removals-global.txt"));
  return buildDirectory(join(PACKAGE_DIR, "dictionaries", id), id, globalRemovals);
}

/**
 * Builds every dictionary under `packageDir/dictionaries/` into `outDir`, replacing whatever was
 * there, and returns what was written.
 */
export async function buildAll(packageDir: string, outDir: string): Promise<BuildReport[]> {
  const root = join(packageDir, "dictionaries");
  const ids = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (ids.length === 0) throw new BuildError("dictionaries/ holds no dictionary");
  const globalRemovals = readText(join(packageDir, "removals-global.txt"));
  const built: BuiltDictionary[] = [];
  for (const id of ids) built.push(await buildDirectory(join(root, id), id, globalRemovals));

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const reports = built.map((dictionary) => writeDictionary(outDir, dictionary));
  const index: DictionaryIndex = {
    dictionaries: built.map((dictionary) => dictionary.manifest),
    globalRemovals: parseEdits("removals-global.txt", globalRemovals),
  };
  writeFileSync(join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  writeServed(outDir, index, join(outDir, "served"));
  return reports;
}

/** The served layout (see above) of the dictionaries built into `outDir`, written to `servedDir`. */
function writeServed(outDir: string, index: DictionaryIndex, servedDir: string): void {
  mkdirSync(servedDir, { recursive: true });
  for (const manifest of index.dictionaries) {
    const name = servedFileName(manifest);
    for (const suffix of ["", ".gz", ".br"]) {
      copyFileSync(
        join(outDir, manifest.id, `words.txt${suffix}`),
        join(servedDir, `${name}${suffix}`),
      );
    }
  }
  writeFileSync(join(servedDir, "index.json"), `${JSON.stringify(index)}\n`);
}
