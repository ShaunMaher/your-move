import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { defines } from "./vite-plugin/defines.js";
import { serviceWorker } from "./vite-plugin/service-worker.js";

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
 * The SPA build (07 §4 CSP compatibility): no inlined assets (`data:` scripts or fonts would
 * break the CSP) and hashed output under /assets/ (cached immutably, 03 §9).
 */
export default defineConfig({
  plugins: [react(), recordInputs(), serviceWorker()],
  define: defines,
  build: {
    assetsInlineLimit: 0,
    assetsDir: "assets",
    sourcemap: true,
    modulePreload: { polyfill: false },
  },
});
