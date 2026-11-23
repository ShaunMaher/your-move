import { mkdirSync, writeFileSync } from "node:fs";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Records every module the build read in generated/bundles/web.json, for `pnpm games:check-inputs`
 * (10 M1): each input from an installed game package must be a file games:verify checked.
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
      const dir = new URL("../../generated/bundles/", import.meta.url);
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
  plugins: [react(), recordInputs()],
  build: {
    assetsInlineLimit: 0,
    assetsDir: "assets",
    sourcemap: true,
    modulePreload: { polyfill: false },
  },
});
