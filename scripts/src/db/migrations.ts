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
 * - **Refused outright**, review line or not: transaction control (Node runs all pending migrations
 *   in one transaction), any pragma but `foreign_keys`, `ATTACH`, `DETACH` and `VACUUM`, and
 *   temporary objects (`TEMP`, `TEMPORARY` or the `temp.` schema).
 * - **One reading**: the file is printable ASCII (tab, LF and CRLF aside), a breakpoint ends its
 *   line, nothing is left unterminated, and the file reads as the same statements whole (D1) and
 *   cut at each breakpoint (Node) ({@link migrationReadings}).
 * - The statement rules are matched with comments removed and whitespace collapsed, in both
 *   readings, so neither a comment nor a statement breakpoint hides them.
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

/** `PRAGMA foreign_keys`, schema-qualified or quoted, at the start of a statement. */
const FOREIGN_KEYS_PRAGMA =
  /^PRAGMA (?:(?:\w+|"[^"]*"|`[^`]*`|\[[^\]]*\]) ?\. ?)?["'`[]?foreign_keys\b/iu;

/** A rule on one statement (after any leading `EXPLAIN`), with what to say when it is broken. */
interface StatementRule {
  readonly breaks: (statement: string) => boolean;
  readonly problem: string;
}

/** The statements that need a reviewed migration. */
const HAZARDS: readonly StatementRule[] = [
  {
    // A table rebuild's DROP TABLE, or the foreign_keys pragma, schema-qualified or quoted.
    breaks: (statement) =>
      /\bDROP TABLE\b/iu.test(statement) || FOREIGN_KEYS_PRAGMA.test(statement),
    problem:
      'drops a table or changes foreign_keys: on D1 that cascades into child tables. Rewrite it, or add "-- migration-reviewed: <how child rows are preserved on both drivers>" after review (04 §Migrations)',
  },
  {
    // ALTER TABLE … DROP [COLUMN] (issue #13 S-2).
    breaks: (statement) => /\bALTER TABLE\b.*\bDROP\b/iu.test(statement),
    problem:
      'drops a column, and its data with it: drizzle-kit writes this when its rename prompt is answered "create" for a renamed column. Rewrite it, or add "-- migration-reviewed: <why the column\'s data may go>" after review (04 §Migrations)',
  },
];

/**
 * Statements no review line allows, matched after a leading `EXPLAIN [QUERY PLAN]` (some pragmas
 * act while a statement is prepared, so an EXPLAIN of one still runs it).
 */
const FORBIDDEN: readonly StatementRule[] = [
  {
    breaks: (statement) => /^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/iu.test(statement),
    problem:
      "begins, ends or nests a transaction (BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT or RELEASE): Node runs the pending migrations in one transaction, so remove it (04 §Migrations)",
  },
  {
    // B1-S-3: foreign_keys is the only pragma drizzle-kit writes (its table rebuild).
    breaks: (statement) => /^PRAGMA\b/iu.test(statement) && !FOREIGN_KEYS_PRAGMA.test(statement),
    problem: "uses a pragma other than foreign_keys, which no migration may (04 §Migrations)",
  },
  {
    // B1-S-4.
    breaks: (statement) => /^(?:ATTACH|DETACH|VACUUM)\b/iu.test(statement),
    problem: "attaches, detaches or vacuums a database, which no migration may (04 §Migrations)",
  },
  {
    // B1-S2-1: `CREATE TEMP …`, `CREATE TEMPORARY …`, or anything qualified by the temp schema
    // (`temp.x`, `"temp".x`), which would live on in the connection that migrates.
    breaks: (statement) =>
      /^CREATE (?:TEMP|TEMPORARY)\b/iu.test(statement) ||
      /(?:\btemp|"temp"|`temp`|\[temp\]) ?\./iu.test(statement),
    problem:
      "creates or names a temporary object (TEMP, TEMPORARY or the temp schema), which no migration may (04 §Migrations)",
  },
];

const EXPLAIN = /^EXPLAIN (?:QUERY PLAN )?/iu;
const REVIEWED = /^--\s*migration-reviewed:\s*\S.{9,}$/u;
/** Anything but printable ASCII, tab and LF, once each CRLF is an LF (B1-S-7). */
const UNEXPECTED_CHARACTER = /[^\t\n\x20-\x7e]/u;
/** A breakpoint with anything after it on its line (B1-S-1). */
const BREAKPOINT_NOT_AT_LINE_END = /--> statement-breakpoint(?!\r?\n|$)/u;

/** A statement for a message: quoted and cut short, or "nothing" past the end. */
const quote = (statement: string | undefined): string =>
  statement === undefined
    ? "nothing"
    : JSON.stringify(statement.length > 60 ? `${statement.slice(0, 57)}...` : statement);

/** Where two statement lists first differ, with each list's statement there; null if equal. */
function firstDifference(
  whole: readonly string[],
  cut: readonly string[],
): { index: number; whole: string; cut: string } | null {
  for (let index = 0; index < Math.max(whole.length, cut.length); index += 1) {
    if (whole[index] !== cut[index]) {
      return { index, whole: quote(whole[index]), cut: quote(cut[index]) };
    }
  }
  return null;
}

/** The 1-based line of `index` in `text`. */
const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/**
 * Problems with one migration's SQL under the text rules (04 §Migrations). The file must be
 * printable ASCII, and its two {@link migrationReadings} must agree: no text after a breakpoint
 * on its line, nothing left unterminated, and the same statements in each. The statement rules
 * are then checked in both readings: a statement either finds counts, and a review line must be
 * a comment in both.
 */
export function lintMigration(file: string, sql: string): string[] {
  const problems: string[] = [];
  const text = sql.replaceAll("\r\n", "\n");
  const unexpected = UNEXPECTED_CHARACTER.exec(text);
  if (unexpected !== null) {
    const code = (unexpected[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    problems.push(
      `${file} has U+${code} on line ${String(lineOf(text, unexpected.index))}: a migration contains only printable ASCII, tabs and line endings, so write the text in ASCII; for a non-ASCII literal use char(…) (04 §Migrations)`,
    );
  }
  const trailing = BREAKPOINT_NOT_AT_LINE_END.exec(text);
  if (trailing !== null) {
    problems.push(
      `${file} has text after "--> statement-breakpoint" on line ${String(lineOf(text, trailing.index))}: Node's migrator runs it, but D1 reads it as part of a comment (04 §Migrations)`,
    );
  }
  const readings = migrationReadings(sql);
  const [whole, cut] = readings;
  if (readings.some((reading) => reading.unterminated)) {
    problems.push(
      `${file} has an unterminated block comment, string or quoted identifier (04 §Migrations)`,
    );
  }
  const differ = firstDifference(whole?.statements ?? [], cut?.statements ?? []);
  if (differ !== null) {
    problems.push(
      `${file} reads as different statements on D1 (the whole file) and on Node (cut at each "--> statement-breakpoint"), from statement ${String(differ.index + 1)}: ${differ.whole} on D1, ${differ.cut} on Node. The usual cause is a missing ";" before a breakpoint (04 §Migrations)`,
    );
  }

  const statements = readings
    .flatMap((reading) => reading.statements)
    .map((statement) => statement.replace(EXPLAIN, ""));
  const reviewed = readings.every((reading) =>
    reading.comments.some((comment) => REVIEWED.test(comment)),
  );
  for (const { breaks, problem } of reviewed ? FORBIDDEN : [...FORBIDDEN, ...HAZARDS]) {
    if (statements.some(breaks)) problems.push(`${file} ${problem}`);
  }
  return problems;
}
