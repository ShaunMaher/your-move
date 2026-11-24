/**
 * Copies the inputs of the Worker bundle (wrangler's esbuild metafile, dist/bundle-meta.json) to
 * generated/bundles/worker.json for `pnpm games:check-inputs` (10 M1): each input from an
 * installed game package must be a file games:verify checked. esbuild's paths are relative to
 * this package's directory, where `pnpm build` runs wrangler. `BUNDLE_INPUTS_DIR` sends the
 * record elsewhere (the contract tests' builds use it).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const metafile = JSON.parse(
  readFileSync(new URL("../dist/bundle-meta.json", import.meta.url), "utf8"),
) as { inputs?: Record<string, unknown> };
if (metafile.inputs === undefined) {
  throw new Error("dist/bundle-meta.json has no inputs: did wrangler write the metafile?");
}
const elsewhere = process.env["BUNDLE_INPUTS_DIR"];
const record =
  elsewhere === undefined
    ? new URL("../../../generated/bundles/", import.meta.url)
    : pathToFileURL(`${elsewhere}/`);
mkdirSync(record, { recursive: true });
writeFileSync(
  new URL("worker.json", record),
  `${JSON.stringify({ baseDir: process.cwd(), inputs: Object.keys(metafile.inputs).sort() }, null, 2)}\n`,
);
console.log(`record-inputs: ${String(Object.keys(metafile.inputs).length)} Worker bundle inputs`);
