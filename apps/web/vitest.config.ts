import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";

import { defines } from "./vite-plugin/defines.js";

export default defineProject({
  plugins: [react()],
  define: defines,
  test: {
    name: "apps/web",
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // Vitest's 5 s default is shorter than the 10 s async-utility budget in vitest.setup.ts, so a
    // slow wait would fail as an opaque test timeout instead of a Testing Library error.
    testTimeout: 15_000,
    include: ["src/**/*.test.{ts,tsx}", "vite-plugin/**/*.test.ts", "sw/**/*.test.ts"],
  },
});
