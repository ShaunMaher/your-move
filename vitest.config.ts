import { existsSync, globSync } from "node:fs";
import { dirname } from "node:path";

import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

/** Every workspace package. */
const ROOTS = globSync(["{apps,packages,games,tests}/*/package.json", "scripts/package.json"])
  .map((file) => dirname(file))
  .sort();

/**
 * The statistical timing suite (ADR 0006) is a measurement, not an ordinary test: `pnpm test` skips
 * it and `pnpm test:timing` (which sets this variable) runs only it.
 */
const TIMING = process.env["YM_TIMING"] === "1";
const TIMING_FILE = "src/auth-timing.test.ts";

/**
 * Every workspace package with tests. A package with its own vitest.config.ts uses it, and must
 * apply the timing switch itself if it holds the timing file (apps/node does).
 */
function projects(): (string | TestProjectInlineConfiguration)[] {
  return ROOTS.map((root) =>
    existsSync(`${root}/vitest.config.ts`)
      ? root
      : {
          extends: true,
          test: {
            name: root,
            root,
            include: TIMING ? [TIMING_FILE] : ["src/**/*.test.ts"],
            exclude: TIMING ? [] : ["**/node_modules/**", `**/${TIMING_FILE}`],
          },
        },
  );
}

/** Packages held to 95 % lines and branches throughout; game engines are added below (11 §4). */
const STRICT: ReadonlySet<string> = new Set(["packages/sdk", "packages/testkit"]);

/**
 * Coverage thresholds per package (11 §4): every package's own sources at 80 % lines on their own,
 * not as part of one aggregate; game engines, the SDK and the testkit at 95 % lines and branches.
 * The test-only packages under tests/ have no sources of their own. Lowering one needs an ADR.
 */
interface Threshold {
  lines: number;
  branches?: number;
}

function thresholds(): Record<string, Threshold> {
  const perPackage = ROOTS.filter((root) => !root.startsWith("tests/")).map(
    (root): [string, Threshold] => [
      `${root}/src/**`,
      STRICT.has(root) ? { lines: 95, branches: 95 } : { lines: 80 },
    ],
  );
  const engines: [string, Threshold] = ["games/*/src/engine/**", { lines: 95, branches: 95 }];
  return Object.fromEntries([...perPackage, engines]);
}

/** One Vitest run over every package (11 §4); coverage thresholds fail the run. */
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
        // The Worker's dictionary loader: it reads the static-assets binding, so it runs only in
        // workerd, under the Worker contract suite (tests/contract), where V8 coverage can't see it.
        "apps/worker/src/dictionaries.ts",
        // The shared repository contract suite and its entry point: test code that ships in src/
        // so both adapters' tests can import it (@your-move/server/testing).
        "packages/server/src/db/repository-contract.ts",
        "packages/server/src/db/testing.ts",
        "apps/web/src/main.tsx",
        "packages/dictionary/src/builder/bench.ts",
        "packages/dictionary/src/builder/cli.ts",
        "scripts/src/bin/**",
      ],
      thresholds: thresholds(),
    },
    reporters: process.env["CI"] ? ["default", "junit"] : ["default"],
    outputFile: { junit: "reports/junit.xml" },
  },
});
