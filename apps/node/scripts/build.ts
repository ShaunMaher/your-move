/**
 * Builds the Node server into apps/node/dist: the bundle (scripts/bundle.ts) plus the built SPA in
 * dist/public. Run with `tsx scripts/build.ts` from apps/node.
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { bundleServer } from "./bundle.js";

const webDist = new URL("../../web/dist/", import.meta.url);
if (!existsSync(webDist)) {
  throw new Error("apps/web/dist is missing: build the web app first (pnpm build does)");
}

const outdir = fileURLToPath(new URL("../dist/", import.meta.url));
const files = await bundleServer(outdir, (inputs) => {
  // For `pnpm games:check-inputs` (10 M1): what the bundle read, relative to this directory.
  const record = new URL("../../../generated/bundles/", import.meta.url);
  mkdirSync(record, { recursive: true });
  writeFileSync(
    new URL("node.json", record),
    `${JSON.stringify({ baseDir: process.cwd(), inputs: [...inputs].sort() }, null, 2)}\n`,
  );
});
cpSync(webDist, new URL("../dist/public/", import.meta.url), { recursive: true });
console.log(
  `build: ${String(files.length)} files in apps/node/dist, plus the web app in dist/public`,
);
