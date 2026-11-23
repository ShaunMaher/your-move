import { existsSync, globSync } from "node:fs";
import { dirname } from "node:path";

import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

/** Every workspace package with tests. A package with its own vitest.config.ts uses it. */
function projects(): (string | TestProjectInlineConfiguration)[] {
  const roots = globSync(["{apps,packages,games,tests}/*/package.json", "scripts/package.json"])
    .map((file) => dirname(file))
    .sort();
  return roots.map((root) =>
    existsSync(`${root}/vitest.config.ts`)
      ? root
      : {
          extends: true,
          test: { name: root, root, include: ["src/**/*.test.ts"] },
        },
  );
}

/**
 * One Vitest run over every package (11 §4). Coverage thresholds fail the run: games' engines and
 * the SDK and testkit at 95 % lines and branches, everything else at 80 % lines. Lowering one needs
 * an ADR.
 */
export default defineConfig({
  test: {
    projects: projects(),
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "cobertura", "html"],
      reportsDirectory: "coverage",
      include: [
        "packages/*/src/**/*.{ts,tsx}",
        "apps/*/src/**/*.{ts,tsx}",
        "games/*/src/**/*.{ts,tsx}",
        "scripts/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/test-support.ts",
        "**/*.d.ts",
        // Generated from the OpenAPI document (11 §3).
        "packages/api-client/src/schema.ts",
        // Process entry points: exercised by the e2e suite and the Docker smoke run, not unit tests.
        "apps/node/src/main.ts",
        "apps/worker/src/index.ts",
        "apps/web/src/main.tsx",
        "scripts/src/bin/**",
      ],
      thresholds: {
        lines: 80,
        "games/*/src/engine/**": { lines: 95, branches: 95 },
        "packages/sdk/src/**": { lines: 95, branches: 95 },
        "packages/testkit/src/**": { lines: 95, branches: 95 },
      },
    },
    reporters: process.env["CI"] ? ["default", "junit"] : ["default"],
    outputFile: { junit: "reports/junit.xml" },
  },
});
