import { defineProject } from "vitest/config";

/** The Worker's tests run in Node (test/); the D1 suite starts workerd through Wrangler. */
export default defineProject({
  test: {
    name: "apps/worker",
    include: ["test/**/*.test.ts"],
    hookTimeout: 120_000,
  },
});
