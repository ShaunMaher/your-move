/**
 * Bundles the Node server (11 §9 build stage): ESM, with the game registry in its own chunk so
 * it loads by a dynamic import after secrets are scrubbed (02 §7.5).
 *
 * Bundled CommonJS dependencies may call `require()` for Node built-ins, so the entry chunk gets
 * a module-scoped `require` from `createRequire`. Only the entry chunk: game code lands in other
 * chunks, which must not get a working `require` (08 T27). esbuild's `banner` option would add it to
 * every chunk, so it is prepended here and the entry's source map shifted to match.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { build } from "esbuild";

export const REQUIRE_BANNER =
  'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);\n';

/** Bundles `apps/node/src/main.ts` into `outdir` (emptied first); returns the files written. */
export async function bundleServer(outdir: string): Promise<string[]> {
  rmSync(outdir, { recursive: true, force: true });
  const result = await build({
    entryPoints: [new URL("../src/main.ts", import.meta.url).pathname],
    outdir,
    bundle: true,
    splitting: true,
    platform: "node",
    format: "esm",
    target: "node26",
    sourcemap: true,
    legalComments: "linked",
    metafile: true,
    logLevel: "warning",
  });
  const main = join(outdir, "main.js");
  writeFileSync(main, REQUIRE_BANNER + readFileSync(main, "utf8"));
  // The banner is one line: start the source map's mappings one generated line later, so stack
  // traces still point at the right source lines.
  const map = `${main}.map`;
  const json = JSON.parse(readFileSync(map, "utf8")) as { mappings: string };
  writeFileSync(map, JSON.stringify({ ...json, mappings: `;${json.mappings}` }));
  return Object.keys(result.metafile.outputs);
}
