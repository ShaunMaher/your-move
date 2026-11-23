/**
 * Builds the Node server into apps/node/dist (11 §9 build stage): one ESM bundle with the game
 * registry in its own chunk (loaded by a dynamic import after secrets are scrubbed, 02 §7.5), plus
 * the built SPA in dist/public. Run with `node scripts/build.ts` from apps/node.
 */
import { cpSync, existsSync, rmSync } from "node:fs";

import { build } from "esbuild";

const webDist = new URL("../../web/dist/", import.meta.url);
if (!existsSync(webDist)) {
  throw new Error("apps/web/dist is missing: build the web app first (pnpm build does)");
}

rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: [new URL("../src/main.ts", import.meta.url).pathname],
  outdir: new URL("../dist/", import.meta.url).pathname,
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node26",
  sourcemap: true,
  legalComments: "linked",
  // Some bundled dependencies are CommonJS and call require() for Node built-ins.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  logLevel: "info",
});

cpSync(webDist, new URL("../dist/public/", import.meta.url), { recursive: true });
