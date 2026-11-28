/**
 * `pnpm gates:prove` (10 M0, 11 §9): shows that each quality gate fails on a deliberate
 * violation, using the real configuration files. Each proof first checks the gate passes on a
 * clean input where that is meaningful, then plants a violation (in a temporary file that is always
 * removed) and requires the gate to fail with the expected message. Exits non-zero if any gate
 * did not fail as it should.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Runs `body` on a scratch copy of the committed migrations, always removed afterwards. */
function withMigrationsCopy<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "gate-migrations-"));
  try {
    cpSync(join(ROOT_DIR, "packages/server/migrations"), dir, { recursive: true });
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Appends a migration to the journal of the migrations folder `dir`. */
function addMigration(dir: string, tag: string, sql: string): void {
  const journalFile = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalFile, "utf8")) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  const last = journal.entries.at(-1);
  journal.entries.push({
    ...last,
    idx: journal.entries.length,
    when: (last?.when ?? 0) + 1000,
    tag,
  });
  writeFileSync(journalFile, JSON.stringify(journal, null, 2));
  writeFileSync(join(dir, `${tag}.sql`), sql);
}

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

  "architecture: an engine importing node:fs, the core using node:http and the schema, the web app importing the server, Drizzle and the build code"() {
    const result = exec(
      join(ROOT_DIR, "node_modules/.bin/depcruise"),
      ["--config", join(ROOT_DIR, ".dependency-cruiser.mjs"), "games", "packages", "apps"],
      { cwd: join(ROOT_DIR, "scripts/test-fixtures/gates/arch") },
    );
    if (result.status === 0) return "dependency-cruiser passed";
    for (const rule of [
      "game-engine-imports",
      "server-web-standard-only",
      "core-storage-through-repositories",
      "drizzle-only-in-storage-adapters",
      "web-only-through-api-client",
      "web-src-not-to-build-code",
    ]) {
      if (!result.output.includes(rule)) return `dependency-cruiser did not report ${rule}`;
    }
    return null;
  },

  "db:check: a column added to schema.ts without a migration"() {
    const schema = join(ROOT_DIR, "packages/server/src/db/schema.ts");
    const original = readFileSync(schema, "utf8");
    const anchor = '    suspendedAt: integer("suspended_at"),\n';
    if (!original.includes(anchor)) return "schema.ts no longer has the anchor line";
    let result: Result;
    try {
      writeFileSync(
        schema,
        original.replace(anchor, `${anchor}    gateFixture: integer("gate_fixture"),\n`),
      );
      result = exec("pnpm", ["db:check"]);
    } finally {
      writeFileSync(schema, original);
    }
    if (result.status === 0) return "db:check passed";
    if (!result.output.includes("schema.ts changed without a committed migration")) {
      return "db:check did not report the missing migration";
    }
    return null;
  },

  "db:check: an unreviewed DROP TABLE hidden behind a comment, in a scratch copy of the migrations"() {
    return withMigrationsCopy((dir) => {
      const clean = exec("pnpm", ["db:check", "--migrations", dir]);
      if (clean.status !== 0) return `db:check fails on an unchanged copy:\n${clean.output}`;
      // Creating and dropping a table leaves the schema as it was: only the rebuild rule fires.
      addMigration(
        dir,
        "0001_gate_fixture",
        "CREATE TABLE `gate_fixture` (`id` text);\n--> statement-breakpoint\nDROP/**/TABLE `gate_fixture`;",
      );
      const result = exec("pnpm", ["db:check", "--migrations", dir]);
      if (result.status === 0) return "db:check passed";
      if (!result.output.includes("0001_gate_fixture.sql drops a table or changes foreign_keys")) {
        return "db:check did not report the unreviewed DROP TABLE";
      }
      return result.output.includes("build a different schema")
        ? "db:check also reported a schema difference, so the proof isn't of the rebuild rule alone"
        : null;
    });
  },

  "db:check: a hand-edited ON DELETE action in a committed migration, in a scratch copy"() {
    return withMigrationsCopy((dir) => {
      const file = join(dir, "0000_init.sql");
      const original = readFileSync(file, "utf8");
      const from =
        "FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null";
      if (!original.includes(from)) return "0000_init.sql no longer has the anchor foreign key";
      writeFileSync(file, original.replace(from, from.replace("set null", "cascade")));
      const result = exec("pnpm", ["db:check", "--migrations", dir]);
      if (result.status === 0) return "db:check passed";
      return result.output.includes("foreign key actor_user_id → users.id")
        ? null
        : "db:check did not report the changed foreign key";
    });
  },

  "db:check: an unreviewed DROP COLUMN, in a scratch copy of the migrations"() {
    return withMigrationsCopy((dir) => {
      // Adding a column and dropping it leaves the schema as it was: only the column rule fires.
      addMigration(
        dir,
        "0003_gate_fixture",
        "ALTER TABLE `users` ADD `gate_fixture` text;\n--> statement-breakpoint\nALTER TABLE `users` DROP COLUMN `gate_fixture`;",
      );
      const result = exec("pnpm", ["db:check", "--migrations", dir]);
      if (result.status === 0) return "db:check passed";
      if (!result.output.includes("0003_gate_fixture.sql drops a column")) {
        return "db:check did not report the unreviewed DROP COLUMN";
      }
      return result.output.includes("build a different schema")
        ? "db:check also reported a schema difference, so the proof isn't of the column rule alone"
        : null;
    });
  },

  "db:check: a hand-added COLLATE in a committed migration, in a scratch copy"() {
    return withMigrationsCopy((dir) => {
      const file = join(dir, "0000_init.sql");
      const original = readFileSync(file, "utf8");
      const from = "`action` text NOT NULL,";
      if (original.split(from).length !== 2) return "0000_init.sql no longer has the anchor column";
      writeFileSync(file, original.replace(from, "`action` text NOT NULL COLLATE NOCASE,"));
      const result = exec("pnpm", ["db:check", "--migrations", dir]);
      if (result.status === 0) return "db:check passed";
      return result.output.includes("table admin_audit: column action: clauses")
        ? null
        : "db:check did not report the added COLLATE";
    });
  },

  "db:check: a statement after a breakpoint on its line, which Node runs and D1 doesn't, in a scratch copy"() {
    return withMigrationsCopy((dir) => {
      addMigration(
        dir,
        "0003_gate_fixture",
        "CREATE INDEX `gate_fixture` ON `users` (`created_at`);--> statement-breakpoint DELETE FROM `users`;\n--> statement-breakpoint\nDROP INDEX `gate_fixture`;",
      );
      const result = exec("pnpm", ["db:check", "--migrations", dir]);
      if (result.status === 0) return "db:check passed";
      for (const expected of [
        '0003_gate_fixture.sql has text after "--> statement-breakpoint" on line 1',
        "0003_gate_fixture.sql reads as different statements on D1",
      ]) {
        if (!result.output.includes(expected)) return `db:check did not report: ${expected}`;
      }
      return null;
    });
  },

  "db:check: an unterminated block comment before a breakpoint, in a scratch copy"() {
    return withMigrationsCopy((dir) => {
      addMigration(
        dir,
        "0003_gate_fixture",
        "SELECT 1;\n/* note\n--> statement-breakpoint\nDELETE FROM `users`;\n",
      );
      const result = exec("pnpm", ["db:check", "--migrations", dir]);
      if (result.status === 0) return "db:check passed";
      return result.output.includes(
        "0003_gate_fixture.sql has an unterminated block comment, string or quoted identifier",
      )
        ? null
        : "db:check did not report the unterminated comment";
    });
  },

  "db:check: a trigger named like one of SQLite's own, in a scratch copy"() {
    return withMigrationsCopy((dir) => {
      addMigration(
        dir,
        "0003_gate_fixture",
        "CREATE TRIGGER sqlite1_purge AFTER INSERT ON `sessions` BEGIN DELETE FROM `sessions` WHERE 1; END;",
      );
      const result = exec("pnpm", ["db:check", "--migrations", dir]);
      if (result.status === 0) return "db:check passed";
      return result.output.includes("trigger sqlite1_purge")
        ? null
        : "db:check did not report the trigger";
    });
  },

  "db:check: a temporary trigger, which would live on in the migrating connection, in a scratch copy"() {
    return withMigrationsCopy((dir) => {
      addMigration(
        dir,
        "0003_gate_fixture",
        "CREATE TEMP TRIGGER `gate_fixture` AFTER INSERT ON main.`sessions` BEGIN DELETE FROM main.`sessions` WHERE 1; END;",
      );
      const result = exec("pnpm", ["db:check", "--migrations", dir]);
      if (result.status === 0) return "db:check passed";
      for (const expected of [
        "0003_gate_fixture.sql creates or names a temporary object",
        "the migrations create temporary objects (trigger gate_fixture)",
      ]) {
        if (!result.output.includes(expected)) return `db:check did not report: ${expected}`;
      }
      return null;
    });
  },

  "games:verify: the installed example's engine importing React and reading the clock"() {
    const engineDir = join(ROOT_DIR, "games/example/src/engine");
    const index = join(engineDir, "index.ts");
    const original = readFileSync(index, "utf8");
    const rebuild = (): Result => exec("pnpm", ["--filter", "@your-move/game-example", "build"]);
    let result: Result;
    try {
      writeFileSync(index, `${original}import "./gate-fixture.js";\n`);
      result = withFile(
        join(engineDir, "gate-fixture.ts"),
        'import { version } from "react";\n\nexport const stamp = `${version}@${String(Date.now())}`;\n',
        () => exec("pnpm", ["games:verify", "--fast"]),
      );
    } finally {
      writeFileSync(index, original);
      for (const built of [".js", ".js.map", ".d.ts", ".d.ts.map"]) {
        rmSync(join(ROOT_DIR, `games/example/dist/engine/gate-fixture${built}`), { force: true });
      }
      rebuild();
    }
    if (result.status === 0) return "games:verify passed";
    for (const expected of ["game-engine-imports", "time only as an argument"]) {
      if (!result.output.includes(expected)) return `games:verify did not report ${expected}`;
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

  "secrets: a token committed in a tracked fixture package's dist/"() {
    // The allow-list skips untracked caches and build output only: a tracked fixture package with
    // a dist/ directory (scripts/test-fixtures) is scanned, in history and in the checkout.
    const dir = mkdtempSync(join(tmpdir(), "gate-secrets-paths-"));
    try {
      const token = `ym_pat_${base62(12)}_${base62(43)}`;
      const plant = (path: string) => {
        mkdirSync(join(dir, path, ".."), { recursive: true });
        writeFileSync(join(dir, path), `export const token = "${token}";\n`);
      };
      const cached = ".pnpm-store/v11/files/00/leak.js";
      const fixture = "scripts/test-fixtures/games/registry/@fixture/game-x/dist/leak.js";
      // As CI runs it: from the checkout, on ".", so reported paths are relative to it. Outside
      // the repository mise's shim has no version to run, so use the binary it resolves here.
      const which = exec("mise", ["which", "gitleaks"]);
      const gitleaks = which.status === 0 ? which.output.trim() : "gitleaks";
      const scan = (mode: "git" | "dir") =>
        exec(
          gitleaks,
          [mode, ".", "--config", join(ROOT_DIR, ".gitleaks.toml"), "--no-banner", "--redact"],
          { cwd: dir },
        );
      const git = (...args: string[]) =>
        exec("git", ["-c", "user.name=gate", "-c", "user.email=gate@example.invalid", ...args], {
          cwd: dir,
        });
      plant(cached);
      if (git("init", "--quiet").status !== 0) return "git init failed";
      const allowed = scan("dir");
      if (allowed.status !== 0)
        return `gitleaks reported the allow-listed cache:\n${allowed.output}`;
      plant(fixture);
      git("add", "--force", fixture);
      if (git("commit", "--quiet", "-m", "fixture").status !== 0) return "git commit failed";
      for (const mode of ["git", "dir"] as const) {
        if (scan(mode).status === 0) return `gitleaks ${mode} passed the fixture`;
      }
      return null;
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
