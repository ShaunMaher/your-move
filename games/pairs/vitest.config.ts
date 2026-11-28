import { defineProject } from "vitest/config";

/** The pairs package's tests (11 §4): the engine's, run in Node. */
export default defineProject({
  test: {
    name: "games/pairs",
    include: ["src/**/*.test.ts"],
  },
});
