/**
 * The structural half of `pnpm db:check` (04 §Migrations, M2a review P2-2): the schema the
 * committed migrations build must be the schema `schema.ts` describes. drizzle-kit's regeneration
 * reads only its JSON snapshots, never the `.sql`, so a hand edit to a committed migration (an FK
 * action, a default, an index's columns or partial predicate) would otherwise pass.
 *
 * Each migration folder is applied to its own in-memory SQLite database, and the two are described
 * by what SQLite reports: every table's `table_info` and `foreign_key_list`, every index's
 * `index_list` entry, `index_xinfo` and its SQL in `sqlite_schema` (which carries a partial
 * index's `WHERE`), and the SQL of any view or trigger. Column positions are left out (see
 * {@link describeSchema}); everything else must match.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import { journalSchema } from "./migrations.js";

/** drizzle-kit's separator between the statements of one migration file. */
const BREAKPOINT = "--> statement-breakpoint";

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
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' OR type = 'index' ORDER BY type, name",
  );
  for (const object of objects) {
    const name = String(object["name"]);
    if (object["type"] === "table") {
      facts.set(`table ${name}`, "exists");
      // Column order (`cid`) is left out: drizzle-kit appends a new column with ALTER TABLE
      // wherever schema.ts declares it, and Drizzle names columns rather than numbering them.
      for (const column of rows(sqlite, "SELECT * FROM pragma_table_info(?)", name)) {
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
  const sqlite = new DatabaseSync(":memory:");
  try {
    applyMigrationFolder(sqlite, folder);
    return describeSchema(sqlite);
  } finally {
    sqlite.close();
  }
}
