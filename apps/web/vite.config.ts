import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Records every module the build read in generated/bundles/web.json, for `pnpm games:check-inputs`
 * (10 M1): each input from an installed game package must be a file games:verify checked.
 * `BUNDLE_INPUTS_DIR` sends the record elsewhere (the contract tests' builds use it).
 */
function recordInputs(): Plugin {
  return {
    name: "record-inputs",
    apply: "build",
    generateBundle() {
      const inputs = [...this.getModuleIds()]
        .filter((id) => !id.startsWith("\0"))
        .map((id) => id.split("?")[0] ?? id)
        .sort();
      const elsewhere = process.env["BUNDLE_INPUTS_DIR"];
      const dir =
        elsewhere === undefined
          ? new URL("../../generated/bundles/", import.meta.url)
          : pathToFileURL(`${elsewhere}/`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        new URL("web.json", dir),
        `${JSON.stringify({ baseDir: process.cwd(), inputs: [...new Set(inputs)] }, null, 2)}\n`,
      );
    },
  };
}

/**
 * Emits `sw.js` (07 §4): `sw/sw.js` with the build's file list in front. Precached: the shell at
 * `/` and every file Vite emitted (hashed, so the list identifies the build), plus the icon.
 * Workbox would do the same; this is the part of it the app needs, with no dependency.
 */
function serviceWorker(): Plugin {
  return {
    name: "service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const precache = ["/", "/icon.svg", ...Object.keys(bundle).map((file) => `/${file}`)]
        .filter((path) => !path.endsWith(".map"))
        .sort();
      const version = createHash("sha256").update(precache.join("\n")).digest("hex").slice(0, 12);
      const template = readFileSync(new URL("sw/sw.js", import.meta.url), "utf8");
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `const BUILD = ${JSON.stringify({ version, precache })};\n${template}`,
      });
    },
  };
}

/**
 * The SPA build (07 §4 CSP compatibility): no inlined assets (`data:` scripts or fonts would
 * break the CSP) and hashed output under /assets/ (cached immutably, 03 §9).
 */
export default defineConfig({
  plugins: [react(), recordInputs(), serviceWorker()],
  build: {
    assetsInlineLimit: 0,
    assetsDir: "assets",
    sourcemap: true,
    modulePreload: { polyfill: false },
  },
});
