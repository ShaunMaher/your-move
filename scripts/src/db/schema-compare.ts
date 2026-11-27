/**
 * The structural half of `pnpm db:check` (04 §Migrations, M2a review P2-2): the schema the
 * committed migrations build must be the schema `schema.ts` describes. drizzle-kit's regeneration
 * reads only its JSON snapshots, never the `.sql`, so a hand edit to a committed migration (an FK
 * action, a default, an index's columns or partial predicate) would otherwise pass.
 *
 * Each migration folder is applied to its own in-memory SQLite database, and the two are described
 * by what SQLite reports: every table's `table_list` entry, `table_xinfo` and `foreign_key_list`,
 * every index's `index_list` entry, `index_xinfo` and its SQL in `sqlite_schema` (which carries a
 * partial index's `WHERE`), and the SQL of any view or trigger. Column positions are left out (see
 * {@link describeSchema}); everything else must match. The table clauses no pragma reports
 * (`COLLATE`, `CHECK`, generated expressions, `DEFERRABLE`) are read from the table's SQL by
 * {@link describeTableClauses} (issue #13 S-1).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import { journalSchema } from "./migrations.js";
import { BREAKPOINT, type SqlToken, tokenizeSql } from "./sql.js";

/** One database's schema, as named facts: `"table users: column email"` → its details as JSON. */
export type SchemaDescription = ReadonlyMap<string, string>;

/** Applies every migration in `folder`'s journal, in order, to `sqlite`. */
function applyMigrationFolder(sqlite: DatabaseSync, folder: string): void {
  const journal = journalSchema.parse(
    JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")),
  );
  sqlite.exec("PRAGMA foreign_keys = OFF");
  for (const entry of journal.entries) {
    const text = readFileSync(join(folder, `${entry.tag}.sql`), "utf8");
    for (const statement of text.split(BREAKPOINT)) {
      if (statement.trim() !== "") sqlite.exec(statement);
    }
  }
}

type Row = Record<string, SQLOutputValue>;

const rows = (sqlite: DatabaseSync, sql: string, ...params: string[]): Row[] =>
  sqlite.prepare(sql).all(...params);

/** `row` without `key`. */
const omit = (row: Row, key: string): Row =>
  Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));

const json = (value: unknown): string => JSON.stringify(value);

/** What SQLite reports about every table, index, view and trigger in `sqlite`. */
function describeSchema(sqlite: DatabaseSync): SchemaDescription {
  const facts = new Map<string, string>();
  const objects = rows(
    sqlite,
    // Every object, SQLite's own included: SQLite refuses a user object whose name starts with
    // `sqlite_` (in any case), so a filter could only hide something (B1-S-2), and comparing its
    // own tables costs nothing (`sqlite_sequence` even shows AUTOINCREMENT, `sqlite_stat1` ANALYZE).
    "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
  );
  for (const object of objects) {
    const name = String(object["name"]);
    if (object["type"] === "table") {
      facts.set(`table ${name}`, "exists");
      // `strict` and `wr` (WITHOUT ROWID); `ncol` counts the columns, hidden ones included.
      for (const entry of rows(sqlite, "SELECT * FROM pragma_table_list WHERE name = ?", name)) {
        facts.set(`table ${name}: options`, json(omit(entry, "schema")));
      }
      // Column order (`cid`) is left out: drizzle-kit appends a new column with ALTER TABLE
      // wherever schema.ts declares it, and Drizzle names columns rather than numbering them.
      // `hidden` tells a generated column (2 virtual, 3 stored) from a stored one (0).
      for (const column of rows(sqlite, "SELECT * FROM pragma_table_xinfo(?)", name)) {
        facts.set(`table ${name}: column ${String(column["name"])}`, json(omit(column, "cid")));
      }
      for (const key of rows(sqlite, "SELECT * FROM pragma_foreign_key_list(?)", name)) {
        // `id` numbers the keys in declaration order, which a rebuild may change; seq orders
        // the columns of one key.
        facts.set(
          `table ${name}: foreign key ${String(key["from"])} → ${String(key["table"])}.${String(key["to"])}`,
          json(omit(key, "id")),
        );
      }
      for (const index of rows(sqlite, "SELECT * FROM pragma_index_list(?)", name)) {
        facts.set(`index ${String(index["name"])}`, json(omit(index, "seq")));
      }
      for (const [fact, value] of describeTableClauses(String(object["sql"]))) {
        facts.set(`table ${name}: ${fact}`, value);
      }
    } else if (object["type"] === "index") {
      facts.set(`index ${name}: sql`, json(object["sql"]));
      facts.set(
        `index ${name}: columns`,
        json(
          rows(sqlite, "SELECT * FROM pragma_index_xinfo(?)", name).map((column) =>
            omit(column, "cid"),
          ),
        ),
      );
    } else {
      facts.set(`${String(object["type"])} ${name}`, json(object["sql"]));
    }
  }
  return facts;
}

/** Where the parenthesised group opening at `tokens[start]` closes (the index of its `)`). */
function closingParen(tokens: readonly SqlToken[], start: number): number {
  let depth = 0;
  for (let at = start; at < tokens.length; at += 1) {
    const text = tokens[at]?.kind === "punctuation" ? tokens[at]?.text : undefined;
    if (text === "(") depth += 1;
    if (text === ")") depth -= 1;
    if (depth === 0) return at;
  }
  return tokens.length - 1;
}

const isWord = (token: SqlToken | undefined, ...words: string[]): boolean =>
  token?.kind === "word" && words.includes(token.text);

const isPunctuation = (token: SqlToken | undefined, text: string): boolean =>
  token?.kind === "punctuation" && token.text === text;

/** Tokens as normalised text: one space between tokens, identifiers unquoted. */
const render = (tokens: readonly SqlToken[]): string => tokens.map((token) => token.text).join(" ");

/** `tokens` split at the commas outside any parentheses. */
function splitTopLevel(tokens: readonly SqlToken[]): SqlToken[][] {
  const parts: SqlToken[][] = [[]];
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token === undefined) continue;
    if (isPunctuation(token, "(")) {
      const close = closingParen(tokens, at);
      parts.at(-1)?.push(...tokens.slice(at, close + 1));
      at = close;
    } else if (isPunctuation(token, ",")) {
      parts.push([]);
    } else {
      parts.at(-1)?.push(token);
    }
  }
  return parts.filter((part) => part.length > 0);
}

/** The `[NOT] DEFERRABLE [INITIALLY DEFERRED|IMMEDIATE]` clause among `tokens`, if any. */
function deferrability(tokens: readonly SqlToken[]): string | undefined {
  const at = tokens.findIndex((token) => isWord(token, "deferrable"));
  if (at === -1) return undefined;
  const start = isWord(tokens[at - 1], "not") ? at - 1 : at;
  const end = isWord(tokens[at + 1], "initially") ? at + 3 : at + 1;
  return render(tokens.slice(start, end));
}

/**
 * The clauses of one column definition no pragma reports: `COLLATE`, `CHECK (…)` and the
 * generated expression `[GENERATED ALWAYS] AS (…) [STORED|VIRTUAL]`, outside any parentheses
 * (a `DEFAULT (…)` expression is in `table_xinfo`), sorted. `references` gets the column's inline
 * `REFERENCES` parent table, if it has one.
 */
function columnClauses(part: readonly SqlToken[]): {
  clauses: string[];
  references: string | undefined;
} {
  const clauses: string[] = [];
  let references: string | undefined;
  for (let at = 1; at < part.length; at += 1) {
    const token = part[at];
    if (isPunctuation(token, "(")) {
      at = closingParen(part, at);
    } else if (isWord(token, "collate")) {
      clauses.push(render(part.slice(at, at + 2)));
      at += 1;
    } else if (
      (isWord(token, "check") || isWord(token, "as")) &&
      isPunctuation(part[at + 1], "(")
    ) {
      const close = closingParen(part, at + 1);
      const storage = isWord(part[close + 1], "stored", "virtual") ? 1 : 0;
      clauses.push(render(part.slice(at, close + 1 + storage)));
      at = close + storage;
    } else if (isWord(token, "references")) {
      references = part[at + 1]?.text;
    }
  }
  return { clauses: clauses.sort(), references };
}

/**
 * The clauses of a table's SQL in `sqlite_schema` that no pragma reports (04 §Migrations, issue
 * #13 S-1), as named facts: each column's `COLLATE`, `CHECK` and generated expression, the
 * table's `CHECK` constraints, and each foreign key's `DEFERRABLE` clause, keyed by its columns
 * and parent table so an inline `REFERENCES` (drizzle-kit's `ALTER TABLE … ADD`) and a table-level
 * `FOREIGN KEY` compare alike. Only clauses that are there make facts. SQL without a column list
 * (`CREATE TABLE … AS SELECT`, a virtual table) is one fact of its own.
 */
export function describeTableClauses(sql: string): SchemaDescription {
  const facts = new Map<string, string>();
  const tokens = tokenizeSql(sql);
  const open = tokens.findIndex((token) => isPunctuation(token, "("));
  // `CREATE TABLE [IF NOT EXISTS] [schema.]name (`, not `CREATE VIRTUAL TABLE` or `… AS SELECT`.
  const head = open === -1 ? [] : tokens.slice(0, open);
  if (
    !isWord(head[0], "create") ||
    !isWord(head[1], "table") ||
    head.some((token) => isWord(token, "as"))
  ) {
    facts.set("sql", json(render(tokens)));
    return facts;
  }
  const checks: string[] = [];
  for (const part of splitTopLevel(tokens.slice(open + 1, closingParen(tokens, open)))) {
    const named = isWord(part[0], "constraint") ? part.slice(2) : part;
    const first = named[0];
    if (isWord(first, "check")) {
      checks.push(render(named));
    } else if (isWord(first, "foreign")) {
      const columns = isPunctuation(named[2], "(") ? named.slice(3, closingParen(named, 2)) : [];
      const at = named.findIndex((token) => isWord(token, "references"));
      const parent = at === -1 ? undefined : named[at + 1]?.text;
      const deferrable = deferrability(named);
      // A key without a parent table isn't SQL SQLite stores (B1-P-3).
      if (deferrable !== undefined && parent !== undefined) {
        const from = columns
          .filter((token) => !isPunctuation(token, ","))
          .map((token) => token.text)
          .join(", ");
        facts.set(`foreign key (${from}) → ${parent}: deferrable`, json(deferrable));
      }
    } else if (!isWord(first, "primary", "unique") && first !== undefined) {
      const { clauses, references } = columnClauses(part);
      if (clauses.length > 0) facts.set(`column ${first.text}: clauses`, json(clauses));
      const deferrable = deferrability(part);
      if (deferrable !== undefined && references !== undefined) {
        facts.set(`foreign key (${first.text}) → ${references}: deferrable`, json(deferrable));
      }
    }
  }
  if (checks.length > 0) facts.set("checks", json(checks.sort()));
  return facts;
}

/** The differences between `committed`'s schema and `expected`'s, one line each. */
export function compareSchemas(
  committed: SchemaDescription,
  expected: SchemaDescription,
): string[] {
  const problems: string[] = [];
  for (const [fact, value] of expected) {
    const actual = committed.get(fact);
    if (actual === undefined) problems.push(`${fact} is missing (schema.ts has ${value})`);
    else if (actual !== value) problems.push(`${fact} is ${actual}, but schema.ts gives ${value}`);
  }
  for (const [fact, value] of committed) {
    if (!expected.has(fact)) problems.push(`${fact} (${value}) is not in schema.ts`);
  }
  return problems;
}

/** Describes the schema `folder`'s migrations build in a fresh in-memory database. */
export function describeMigrations(folder: string): SchemaDescription {
  const sqlite = new DatabaseSync(":memory:", { defensive: true });
  try {
    applyMigrationFolder(sqlite, folder);
    return describeSchema(sqlite);
  } finally {
    sqlite.close();
  }
}
