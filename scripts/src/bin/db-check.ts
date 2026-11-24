/**
 * `pnpm db:check` (docs/spec/04-data-model.md §Migrations, 11 §3; CI's validate job): the
 * committed migrations' journal and rebuild rule (scripts/src/db/migrations.ts), then drizzle-kit
 * regenerated from `schema.ts` into a scratch copy must change nothing — a schema change always
 * comes with its committed migration.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { checkJournal, journalSchema, lintMigration } from "../db/migrations.js";
import { fail, ROOT_DIR, run } from "./cli.js";

const COMMAND = "db:check";
const SERVER = join(ROOT_DIR, "packages/server");
const MIGRATIONS = join(SERVER, "migrations");

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

run(COMMAND, () => {
  const problems: string[] = [];
  const journal = journalSchema.parse(
    JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")),
  );
  const sqlFiles = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql"));
  problems.push(...checkJournal(journal, sqlFiles));
  for (const file of sqlFiles) {
    problems.push(...lintMigration(file, readFileSync(join(MIGRATIONS, file), "utf8")));
  }

  const scratch = mkdtempSync(join(tmpdir(), "db-check-"));
  try {
    cpSync(MIGRATIONS, scratch, { recursive: true });
    // drizzle-kit prefixes --out with ./, so it must be relative to the package.
    const output = execFileSync(
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
        relative(SERVER, scratch),
      ],
      { cwd: SERVER, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    // drizzle-kit can report an error and still exit 0: require its "nothing to do" line.
    if (!output.includes("No schema changes")) {
      problems.push(`drizzle-kit generate did not report "No schema changes":\n${output}`);
    }
    const committed = snapshot(MIGRATIONS);
    const regenerated = snapshot(scratch);
    for (const [file, text] of regenerated) {
      if (committed.get(file) !== text) {
        problems.push(
          `drizzle-kit generates ${file} differently: schema.ts changed without a committed migration (pnpm --filter @your-move/server db:generate <name>)`,
        );
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (problems.length > 0) fail(COMMAND, problems);
  console.log(
    `${COMMAND}: ${String(sqlFiles.length)} migration(s), journal consistent, schema.ts matches`,
  );
  return Promise.resolve();
});
