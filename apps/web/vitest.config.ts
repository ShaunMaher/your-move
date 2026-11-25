import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [react()],
  test: {
    name: "apps/web",
    environment: "jsdom",
    // The whole suite runs in parallel; a slow machine gets a wide margin.
    testTimeout: 20_000,
    include: ["src/**/*.test.{ts,tsx}", "build/**/*.test.ts", "sw/**/*.test.ts"],
  },
});
