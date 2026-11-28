import { defineProject } from "vitest/config";

/**
 * The words package's tests (11 §4): engine tests run in Node, client component tests opt into
 * jsdom with a `@vitest-environment jsdom` comment.
 */
export default defineProject({
  test: {
    name: "games/words",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
