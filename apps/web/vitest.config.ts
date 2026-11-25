import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";

import { defines } from "./vite-plugin/defines.js";

export default defineProject({
  plugins: [react()],
  define: defines,
  test: {
    name: "apps/web",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "vite-plugin/**/*.test.ts", "sw/**/*.test.ts"],
  },
});
