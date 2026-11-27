/**
 * Checks on the committed SQL migrations (`packages/server/migrations/`, docs/spec/04-data-model.md
 * §Migrations), run by `pnpm db:check` in CI's validate job:
 *
 * - **Journal**: entries numbered 0..n-1, `when` strictly increasing with `idx`, and the `*.sql`
 *   files exactly the journal's tags.
 * - **Rebuild rule**: D1 always enforces foreign keys, and `defer_foreign_keys` doesn't stop
 *   `ON DELETE` actions, so a migration's `DROP TABLE` (drizzle-kit's table rebuild) would cascade
 *   into child tables on Cloudflare even though Node turns foreign keys off while migrating. A
 *   migration with `DROP TABLE` or `PRAGMA foreign_keys` must carry a reviewed
 *   `-- migration-reviewed: <how child rows are preserved on both drivers>` line.
 * - **Dropped columns**: `ALTER TABLE … DROP [COLUMN]` loses the column's data, and is what
 *   drizzle-kit writes for a rename when its prompt is answered wrongly, so it needs a review line
 *   too.
 * - The patterns are matched with comments removed and whitespace collapsed, in both readings of
 *   the file ({@link migrationReadings}), so neither a comment nor a statement breakpoint hides
 *   them.
 * - **No transaction control**: Node runs all pending migrations in one transaction, so a
 *   migration may not begin, end or nest one (`BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`,
 *   `RELEASE`); no review marker allows it.
 * - **Structure** (in the bin): the schema the committed migrations build must equal the schema a
 *   fresh drizzle-kit generation from `schema.ts` builds (scripts/src/db/schema-compare.ts), and
 *   drizzle-kit regenerated over the committed folder must reproduce it exactly (11 §3).
 */
import { z } from "zod";

import { migrationReadings } from "./sql.js";

export const journalSchema = z.object({
  entries: z.array(
    z.object({ idx: z.number().int(), when: z.number().int(), tag: z.string().min(1) }),
  ),
});

export type Journal = z.infer<typeof journalSchema>;

/** Problems with the journal and the `.sql` files beside it. */
export function checkJournal(journal: Journal, sqlFiles: readonly string[]): string[] {
  const problems: string[] = [];
  journal.entries.forEach((entry, position) => {
    if (entry.idx !== position) {
      problems.push(`journal entry ${String(position)} has idx ${String(entry.idx)}`);
    }
    const previous = journal.entries[position - 1];
    if (previous !== undefined && entry.when <= previous.when) {
      problems.push(`journal entry ${entry.tag}: "when" is not after ${previous.tag}'s`);
    }
  });
  const tags = new Set(journal.entries.map((entry) => `${entry.tag}.sql`));
  for (const file of sqlFiles) {
    if (!tags.has(file)) problems.push(`${file} is not in the journal`);
  }
  const files = new Set(sqlFiles);
  for (const tag of tags) {
    if (!files.has(tag)) problems.push(`the journal names ${tag}, which doesn't exist`);
  }
  return problems;
}

/** The patterns that need a reviewed migration, with what to say when one has none. */
const HAZARDS: readonly { readonly pattern: RegExp; readonly problem: string }[] = [
  {
    // A table rebuild's DROP TABLE, or the foreign_keys pragma, schema-qualified or quoted.
    pattern:
      /\bDROP TABLE\b|\bPRAGMA (?:(?:\w+|"[^"]*"|`[^`]*`|\[[^\]]*\]) ?\. ?)?["'`[]?foreign_keys\b/iu,
    problem:
      'drops a table or changes foreign_keys: on D1 that cascades into child tables. Rewrite it, or add "-- migration-reviewed: <how child rows are preserved on both drivers>" after review (04 §Migrations)',
  },
  {
    // ALTER TABLE … DROP [COLUMN] (issue #13 S-2).
    pattern: /\bALTER TABLE\b.*\bDROP\b/iu,
    problem:
      'drops a column, and its data with it: drizzle-kit writes this when its rename prompt is answered "create" for a renamed column. Rewrite it, or add "-- migration-reviewed: <why the column\'s data may go>" after review (04 §Migrations)',
  },
];
/** A statement that begins, ends or nests a transaction. */
const TRANSACTION_CONTROL = /^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/iu;
const REVIEWED = /^--\s*migration-reviewed:\s*\S.{9,}$/u;

/**
 * Problems with one migration's SQL under the text rules (04 §Migrations), checked in both of
 * its {@link migrationReadings}: a statement either finds counts, and a review line must be a
 * comment in both.
 */
export function lintMigration(file: string, sql: string): string[] {
  const readings = migrationReadings(sql);
  const statements = readings.flatMap((reading) => reading.statements);
  const reviewed = readings.every((reading) =>
    reading.comments.some((comment) => REVIEWED.test(comment)),
  );
  const problems: string[] = [];
  if (statements.some((statement) => TRANSACTION_CONTROL.test(statement))) {
    problems.push(
      `${file} begins, ends or nests a transaction (BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT or RELEASE): Node runs the pending migrations in one transaction, so remove it (04 §Migrations)`,
    );
  }
  if (!reviewed) {
    for (const { pattern, problem } of HAZARDS) {
      if (statements.some((statement) => pattern.test(statement))) {
        problems.push(`${file} ${problem}`);
      }
    }
  }
  return problems;
}
