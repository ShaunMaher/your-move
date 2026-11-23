import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The SPA build (07 §4 CSP compatibility): no inlined assets (`data:` scripts or fonts would
 * break the CSP) and hashed output under /assets/ (cached immutably, 03 §9).
 */
export default defineConfig({
  plugins: [react()],
  build: {
    assetsInlineLimit: 0,
    assetsDir: "assets",
    sourcemap: true,
    modulePreload: { polyfill: false },
  },
});
