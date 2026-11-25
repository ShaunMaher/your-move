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
 *   `-- migration-reviewed: <how child rows are preserved on both drivers>` line. The patterns are
 *   matched with comments removed and whitespace collapsed ({@link lexSql}), so neither hides them.
 * - **No transaction control**: Node runs all pending migrations in one transaction, so a
 *   migration may not begin, end or nest one (`BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`,
 *   `RELEASE`); no review marker allows it.
 * - **Structure** (in the bin): the schema the committed migrations build must equal the schema a
 *   fresh drizzle-kit generation from `schema.ts` builds (scripts/src/db/schema-compare.ts), and
 *   drizzle-kit regenerated over the committed folder must reproduce it exactly (11 §3).
 */
import { z } from "zod";

import { lexSql } from "./sql.js";

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

/** A statement that drops a table or sets `foreign_keys`, schema-qualified or quoted. */
const HAZARDS: readonly RegExp[] = [
  /\bDROP TABLE\b/iu,
  /\bPRAGMA (?:(?:\w+|"[^"]*"|`[^`]*`|\[[^\]]*\]) ?\. ?)?["'`[]?foreign_keys\b/iu,
];
/** A statement that begins, ends or nests a transaction. */
const TRANSACTION_CONTROL = /^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/iu;
const REVIEWED = /^--\s*migration-reviewed:\s*\S.{9,}$/u;

/** Problems with one migration's SQL under the rebuild and transaction rules. */
export function lintMigration(file: string, sql: string): string[] {
  const { statements, comments } = lexSql(sql);
  const problems: string[] = [];
  if (statements.some((statement) => TRANSACTION_CONTROL.test(statement))) {
    problems.push(
      `${file} begins, ends or nests a transaction (BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT or RELEASE): Node runs the pending migrations in one transaction, so remove it (04 §Migrations)`,
    );
  }
  const hazardous = statements.some((statement) =>
    HAZARDS.some((hazard) => hazard.test(statement)),
  );
  if (hazardous && !comments.some((comment) => REVIEWED.test(comment))) {
    problems.push(
      `${file} drops a table or changes foreign_keys: on D1 that cascades into child tables. Rewrite it, or add "-- migration-reviewed: <how child rows are preserved on both drivers>" after review (04 §Migrations)`,
    );
  }
  return problems;
}
