/**
 * Builds the Node server into apps/node/dist: the bundle (scripts/bundle.ts) plus the built SPA in
 * dist/public. Run with `tsx scripts/build.ts` from apps/node.
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { bundleServer } from "./bundle.js";

const webDist = new URL("../../web/dist/", import.meta.url);
if (!existsSync(webDist)) {
  throw new Error("apps/web/dist is missing: build the web app first (pnpm build does)");
}

const outdir = fileURLToPath(new URL("../dist/", import.meta.url));
const files = await bundleServer(outdir, (inputs) => {
  // For `pnpm games:check-inputs` (10 M1): what the bundle read, relative to this directory.
  // `BUNDLE_INPUTS_DIR` sends the record elsewhere (the contract tests' builds use it).
  const elsewhere = process.env["BUNDLE_INPUTS_DIR"];
  const record =
    elsewhere === undefined
      ? new URL("../../../generated/bundles/", import.meta.url)
      : pathToFileURL(`${elsewhere}/`);
  mkdirSync(record, { recursive: true });
  writeFileSync(
    new URL("node.json", record),
    `${JSON.stringify({ baseDir: process.cwd(), inputs: [...inputs].sort() }, null, 2)}\n`,
  );
});
cpSync(webDist, new URL("../dist/public/", import.meta.url), { recursive: true });
// The shared SQL migrations, applied at startup (dist/main.js reads dist/migrations by default).
cpSync(
  new URL("../../../packages/server/migrations/", import.meta.url),
  new URL("../dist/migrations/", import.meta.url),
  { recursive: true },
);
console.log(
  `build: ${String(files.length)} files in apps/node/dist, plus the web app in dist/public and the migrations in dist/migrations`,
);
