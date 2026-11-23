/**
 * `pnpm gates:prove` (10 M0, 11 §9): shows that each quality gate fails on a deliberate
 * violation, using the real configuration files. Each proof first checks the gate passes on a
 * clean input where that is meaningful, then plants a violation (in a temporary file that is always
 * removed) and requires the gate to fail with the expected message. Exits non-zero if any gate
 * did not fail as it should.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fail, ROOT_DIR } from "./cli.js";

interface Result {
  readonly status: number | null;
  readonly output: string;
}

function exec(
  command: string,
  args: readonly string[],
  options: { cwd?: string; input?: string } = {},
): Result {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT_DIR,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

/** Writes `content` to `file` for the duration of `body`, then removes it. */
function withFile<T>(file: string, content: string, body: () => T): T {
  writeFileSync(file, content);
  try {
    return body();
  } finally {
    rmSync(file, { force: true });
  }
}

const base62 = (length: number): string =>
  Array.from(randomBytes(length), (byte) =>
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".charAt(byte % 62),
  ).join("");

type Proof = () => string | null; // null when the gate failed as expected, else what went wrong

const proofs: Record<string, Proof> = {
  "lint: an engine using Math.random, console and a hard-coded product name"() {
    const file = join(ROOT_DIR, "games/words/src/engine/gate-fixture.ts");
    const productName = ["Your", "Move"].join(" ");
    const result = withFile(
      file,
      `export const roll = (): number => Math.random();\nconsole.log("${productName}");\n`,
      () => exec("pnpm", ["exec", "eslint", "--max-warnings", "0", file]),
    );
    if (result.status === 0) return "eslint passed";
    for (const expected of [
      "Randomness comes from RandomSource",
      "no-console",
      "no-product-name",
    ]) {
      if (!result.output.includes(expected)) return `eslint did not report ${expected}`;
    }
    return null;
  },

  "architecture: an engine importing node:fs, the core using node:http, the web app importing the server"() {
    const result = exec(
      join(ROOT_DIR, "node_modules/.bin/depcruise"),
      ["--config", join(ROOT_DIR, ".dependency-cruiser.mjs"), "games", "packages", "apps"],
      { cwd: join(ROOT_DIR, "scripts/test-fixtures/gates/arch") },
    );
    if (result.status === 0) return "dependency-cruiser passed";
    for (const rule of [
      "game-engine-imports",
      "server-web-standard-only",
      "web-only-through-api-client",
    ]) {
      if (!result.output.includes(rule)) return `dependency-cruiser did not report ${rule}`;
    }
    return null;
  },

  "coverage: an untested function in the SDK drops it below 95 %"() {
    const args = [
      "exec",
      "vitest",
      "run",
      "--project",
      "packages/sdk",
      "--coverage",
      // With a single project selected, coverage globs are relative to that project's root.
      "--coverage.include=src/**",
      "--coverage.reporter=text-summary",
    ];
    const clean = exec("pnpm", args);
    if (clean.status !== 0) return `the clean SDK run already fails:\n${clean.output}`;
    const untested = Array.from(
      { length: 40 },
      (_, index) =>
        `export function untested${String(index)}(n: number): number {\n  return n + ${String(index)};\n}\n`,
    ).join("");
    const result = withFile(join(ROOT_DIR, "packages/sdk/src/gate-fixture.ts"), untested, () =>
      exec("pnpm", args),
    );
    if (result.status === 0) return "vitest passed with the coverage drop";
    return result.output.includes('does not meet "packages/sdk/src/**" threshold (95%)')
      ? null
      : "vitest failed for another reason";
  },

  "secrets: a leaked ym_pat_ token"() {
    const dir = mkdtempSync(join(tmpdir(), "gate-secrets-"));
    try {
      const report = join(dir, "report.json");
      writeFileSync(
        join(dir, "leak.ts"),
        `export const token = "ym_pat_${base62(12)}_${base62(43)}";\n`,
      );
      const result = exec("gitleaks", [
        "dir",
        dir,
        "--config",
        join(ROOT_DIR, ".gitleaks.toml"),
        "--no-banner",
        "--redact",
        "--report-format",
        "json",
        "--report-path",
        report,
      ]);
      if (result.status === 0) return "gitleaks passed";
      return readFileSync(report, "utf8").includes('"RuleID": "your-move-api-token"')
        ? null
        : "gitleaks failed without the ym_pat_ rule";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  "licences: a production dependency under GPL-3.0-only"() {
    const clean = exec("pnpm", ["exec", "tsx", "scripts/src/bin/licences-check.ts"]);
    if (clean.status !== 0) return `the repository's own licences fail:\n${clean.output}`;
    // The real path: pnpm's licence listing of a project with a GPL production dependency (a
    // local file: package, so the install works offline), checked by the real CLI. The copy
    // lives under node_modules so the repository's mise and pnpm settings apply.
    const dir = join(ROOT_DIR, "node_modules/.cache/gate-licences");
    rmSync(dir, { recursive: true, force: true });
    cpSync(join(ROOT_DIR, "scripts/test-fixtures/licences"), dir, { recursive: true });
    try {
      const install = exec(
        "pnpm",
        ["install", "--ignore-workspace", "--offline", "--ignore-scripts", "--no-frozen-lockfile"],
        { cwd: dir },
      );
      if (install.status !== 0) return `the fixture project didn't install:\n${install.output}`;
      const result = exec("pnpm", [
        "exec",
        "tsx",
        "scripts/src/bin/licences-check.ts",
        "--dir",
        dir,
      ]);
      if (result.status === 0) return "the licence check passed";
      return result.output.includes('gate-fixture-copyleft@file:copyleft: "GPL-3.0-only"')
        ? null
        : "the licence check failed for another reason";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  "OpenAPI: removing an endpoint from v1"() {
    const dir = mkdtempSync(join(tmpdir(), "gate-openapi-"));
    try {
      const base = join(ROOT_DIR, "packages/api-client/openapi/v1.json");
      const document = JSON.parse(readFileSync(base, "utf8")) as { paths: Record<string, unknown> };
      Reflect.deleteProperty(document.paths, "/api/v1/health");
      const revision = join(dir, "v1.json");
      writeFileSync(revision, JSON.stringify(document));
      const clean = exec("oasdiff", ["breaking", base, base, "--fail-on", "ERR"]);
      if (clean.status !== 0) return `oasdiff fails on an unchanged document:\n${clean.output}`;
      const result = exec("oasdiff", ["breaking", base, revision, "--fail-on", "ERR"]);
      if (result.status === 0) return "oasdiff passed";
      return result.output.includes("api-path-removed")
        ? null
        : "oasdiff failed for another reason";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  "commit messages: one not in Conventional Commits form"() {
    const good = exec("pnpm", ["exec", "commitlint"], { input: "feat: add the health check\n" });
    if (good.status !== 0) return `commitlint rejects a valid message:\n${good.output}`;
    const bad = exec("pnpm", ["exec", "commitlint"], { input: "Added some stuff\n" });
    return bad.status === 0 ? "commitlint passed" : null;
  },
};

const failures: string[] = [];
for (const [name, proof] of Object.entries(proofs)) {
  const problem = proof();
  console.log(`${problem === null ? "ok  " : "FAIL"} ${name}`);
  if (problem !== null) failures.push(`${name}: ${problem}`);
}
if (failures.length > 0) fail("gates:prove", failures);
console.log("gates:prove: every gate fails on its deliberate violation");
