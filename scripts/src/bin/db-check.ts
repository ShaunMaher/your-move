/**
 * `pnpm db:check` (docs/spec/04-data-model.md §Migrations, 11 §3; CI's validate job), over the
 * committed migrations (or the folder `--migrations` names, which `gates:prove` uses for its
 * scratch copies):
 *
 * 1. the journal and each migration's text (scripts/src/db/migrations.ts): the rebuild rule and
 *    no transaction control;
 * 2. structure (scripts/src/db/schema-compare.ts): the schema the migrations build must equal the
 *    schema built by a fresh drizzle-kit generation from `schema.ts` into an empty folder, so a
 *    hand edit to a committed `.sql` fails;
 * 3. regeneration: drizzle-kit generated over a copy of the folder must change nothing, so a
 *    schema change always comes with its committed migration and snapshot.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { checkJournal, journalSchema, lintMigration } from "../db/migrations.js";
import { compareSchemas, describeMigrations } from "../db/schema-compare.js";
import { fail, ROOT_DIR, run } from "./cli.js";

const COMMAND = "db:check";
const SERVER = join(ROOT_DIR, "packages/server");

/** Every file under `dir`, relative to it, with its contents. */
function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(dir, path), readFileSync(path, "utf8"));
  }
  return files;
}

/** Runs drizzle-kit generate from `schema.ts` into `out`, returning its output. */
function generate(out: string): string {
  // drizzle-kit prefixes --out with ./, so it must be relative to the package.
  return execFileSync(
    "pnpm",
    [
      "exec",
      "drizzle-kit",
      "generate",
      "--dialect",
      "sqlite",
      "--schema",
      "./src/db/schema.ts",
      "--out",
      relative(SERVER, out),
    ],
    { cwd: SERVER, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** Runs `body` with a fresh scratch directory, always removed afterwards. */
function withScratch<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "db-check-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

run(COMMAND, () => {
  const { values } = parseArgs({
    options: { migrations: { type: "string", default: join(SERVER, "migrations") } },
  });
  const migrations = resolve(values.migrations);
  const problems: string[] = [];

  // 1. Journal and text.
  const journal = journalSchema.parse(
    JSON.parse(readFileSync(join(migrations, "meta", "_journal.json"), "utf8")),
  );
  const sqlFiles = readdirSync(migrations).filter((file) => file.endsWith(".sql"));
  problems.push(...checkJournal(journal, sqlFiles));
  for (const file of sqlFiles) {
    problems.push(...lintMigration(file, readFileSync(join(migrations, file), "utf8")));
  }

  // 2. Structure: committed migrations against a generation from empty.
  withScratch((fresh) => {
    generate(fresh);
    const differences = compareSchemas(describeMigrations(migrations), describeMigrations(fresh));
    problems.push(
      ...differences.map(
        (difference) =>
          `the committed migrations build a different schema from schema.ts: ${difference}`,
      ),
    );
  });

  // 3. Regeneration over the committed folder.
  withScratch((scratch) => {
    cpSync(migrations, scratch, { recursive: true });
    const output = generate(scratch);
    // drizzle-kit can report an error and still exit 0: require its "nothing to do" line.
    if (!output.includes("No schema changes")) {
      problems.push(`drizzle-kit generate did not report "No schema changes":\n${output}`);
    }
    const committed = snapshot(migrations);
    for (const [file, text] of snapshot(scratch)) {
      if (committed.get(file) !== text) {
        problems.push(
          `drizzle-kit generates ${file} differently: schema.ts changed without a committed migration (pnpm --filter @your-move/server db:generate <name>)`,
        );
      }
    }
  });

  if (problems.length > 0) fail(COMMAND, problems);
  console.log(
    `${COMMAND}: ${String(sqlFiles.length)} migration(s), journal consistent, schema.ts matches their structure and snapshots`,
  );
  return Promise.resolve();
});
