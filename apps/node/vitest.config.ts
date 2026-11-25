import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "apps/node",
    include: ["src/**/*.test.ts"],
    // The game tests read the built-in dictionaries' served layout: built first if missing.
    globalSetup: ["src/test-global-setup.ts"],
  },
});
