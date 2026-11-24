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
 * - **Regeneration** (in the bin): drizzle-kit regenerated from `schema.ts` must reproduce the
 *   committed files exactly (11 §3).
 */
import { z } from "zod";

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

const HAZARD = /\bDROP\s+TABLE\b|\bPRAGMA\s+foreign_keys\b/iu;
const REVIEWED = /^--\s*migration-reviewed:\s*\S.{9,}$/mu;

/** Problems with one migration's SQL under the rebuild rule. */
export function lintMigration(file: string, sql: string): string[] {
  if (!HAZARD.test(sql) || REVIEWED.test(sql)) return [];
  return [
    `${file} drops a table or changes foreign_keys: on D1 that cascades into child tables. Rewrite it, or add "-- migration-reviewed: <how child rows are preserved on both drivers>" after review (04 §Migrations)`,
  ];
}
