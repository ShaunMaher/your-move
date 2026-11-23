import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "tests/contract",
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
