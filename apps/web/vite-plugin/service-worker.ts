import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { SERVER_PATHS } from "@your-move/shared/server-paths";
import type { Plugin } from "vite";

/** What the build tells the worker (prepended to `sw/sw.js` as `BUILD`). */
export interface BuildInfo {
  /** Identifies the build: a hash of the content of every precached file. */
  readonly version: string;
  /** Request paths stored at install: the shell at `/` and every file the build emitted. */
  readonly precache: readonly string[];
  /** Paths the worker leaves to the server (`@your-move/shared/server-paths`). */
  readonly serverPaths: readonly string[];
}

/** Not part of the shell: the worker itself, source maps and the static host's headers file. */
const NOT_PRECACHED = /(^|\/)(sw\.js|_headers)$|\.map$/u;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"));
}

/**
 * The precache list and version of an output directory. Everything the build emitted is
 * precached (the HTML, hashed assets and the public files); the version hashes each file's
 * content, so a change to any of them, `index.html` and the icons included, is a new version
 * and installs a new cache (07 §4).
 */
export function buildInfo(outDir: string): BuildInfo {
  const files = filesUnder(outDir)
    .filter((file) => !NOT_PRECACHED.test(file))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash
      .update(`${file}\0`)
      .update(readFileSync(join(outDir, file)))
      .update("\0");
  }
  return {
    version: hash.digest("hex").slice(0, 12),
    precache: ["/", ...files.map((file) => `/${file}`)],
    serverPaths: SERVER_PATHS,
  };
}

/** The text of `/sw.js`: the build's information in front of the worker's source. */
export function renderWorker(info: BuildInfo, template: string): string {
  return `const BUILD = ${JSON.stringify(info)};\n${template}`;
}

/**
 * Emits `sw.js` (07 §4) into the output directory once everything else is written there, so the
 * version covers the public files too. A hand-written worker: no dependency, only what the app
 * needs.
 */
export function serviceWorker(): Plugin {
  let outDir = "";
  return {
    name: "service-worker",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    writeBundle() {
      const template = readFileSync(new URL("../sw/sw.js", import.meta.url), "utf8");
      writeFileSync(join(outDir, "sw.js"), renderWorker(buildInfo(outDir), template));
    },
  };
}
