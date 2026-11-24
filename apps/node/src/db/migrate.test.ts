import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { schema } from "@your-move/server/testing";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, MigrationError } from "./migrate.js";
import { openSqlite } from "./sqlite.js";

const MIGRATIONS = fileURLToPath(
  new URL("../../../../packages/server/migrations", import.meta.url),
);

/** The tables 04 defines. */
const TABLES = [
  "admin_audit",
  "api_tokens",
  "auth_events",
  "blocks",
  "dictionaries",
  "email_suppressions",
  "game_actions",
  "game_players",
  "game_resources",
  "games",
  "invites",
  "join_links",
  "otp_challenges",
  "past_opponents",
  "push_subscriptions",
  "rate_limits",
  "sessions",
  "users",
];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "migrate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tables(path: string): string[] {
  const sqlite = openSqlite(path);
  try {
    return (
      sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
  } finally {
    sqlite.close();
  }
}

/** A copy of the migrations folder with one more migration, `millis` after the first. */
function withExtraMigration(sql: string, millis: number): string {
  const folder = join(dir, "migrations");
  cpSync(MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
  };
  const first = journal.entries[0];
  if (first === undefined) throw new Error("no migrations");
  journal.entries.push({ ...first, idx: 1, when: first.when + millis, tag: "0001_extra" });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(join(folder, "0001_extra.sql"), sql);
  return folder;
}

describe("migrate", () => {
  it("creates every table of the data model, then has nothing left to do", () => {
    const path = join(dir, "app.sqlite");
    const sqlite = openSqlite(path);
    expect(migrate(sqlite, MIGRATIONS)).toEqual({ applied: 1, known: 1 });
    expect(migrate(sqlite, MIGRATIONS)).toEqual({ applied: 0, known: 1 });
    sqlite.close();
    expect(tables(path).filter((name) => !name.startsWith("__"))).toEqual(TABLES);
  });

  it("produces exactly the shared schema: a schema change needs a migration", () => {
    const sqlite = openSqlite(":memory:");
    migrate(sqlite, MIGRATIONS);
    const tables = (Object.values(schema) as unknown[]).filter(
      (value): value is SQLiteTable => value instanceof SQLiteTable,
    );
    expect(tables.map((table) => getTableConfig(table).name).sort()).toEqual(TABLES);
    for (const table of tables) {
      const config = getTableConfig(table);
      const expected = config.columns
        .map((column) => ({
          name: column.name,
          type: column.getSQLType().toLowerCase(),
          notnull: column.notNull ? 1 : 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const actual = (
        sqlite.prepare(`PRAGMA table_info("${config.name}")`).all() as {
          name: string;
          type: string;
          notnull: number;
        }[]
      )
        .map(({ name, type, notnull }) => ({ name, type: type.toLowerCase(), notnull }))
        .sort((a, b) => a.name.localeCompare(b.name));
      expect(actual, config.name).toEqual(expected);
      const indexes = (
        sqlite.prepare(`PRAGMA index_list("${config.name}")`).all() as {
          name: string;
          origin: string;
        }[]
      )
        .filter((index) => index.origin === "c")
        .map((index) => index.name)
        .sort();
      // Named indexes plus the unique columns' indexes (drizzle-kit creates both explicitly).
      const declared = [
        ...config.indexes.map((index) => index.config.name),
        ...config.columns.filter((column) => column.isUnique).map((column) => column.uniqueName),
      ];
      expect(indexes, config.name).toEqual(declared.sort());
    }
    sqlite.close();
  });

  it("applies only the migrations added since the last start", () => {
    const sqlite = openSqlite(join(dir, "app.sqlite"));
    migrate(sqlite, MIGRATIONS);
    const folder = withExtraMigration("CREATE TABLE `extra` (`id` text PRIMARY KEY);", 1000);
    expect(migrate(sqlite, folder)).toEqual({ applied: 1, known: 2 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM extra").get()).toEqual({ n: 0 });
    sqlite.close();
  });

  it("rolls a failed migration back completely", () => {
    const sqlite = openSqlite(join(dir, "app.sqlite"));
    const folder = withExtraMigration(
      "CREATE TABLE `extra` (`id` text);\n--> statement-breakpoint\nTHIS IS NOT SQL;",
      1000,
    );
    expect(() => migrate(sqlite, folder)).toThrow();
    // Neither the first migration nor the half of the second ran.
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'users'").get(),
    ).toEqual({ n: 0 });
    expect(sqlite.isTransaction).toBe(false);
    sqlite.close();
  });

  it("refuses a database that a newer build has migrated", () => {
    const sqlite = openSqlite(join(dir, "app.sqlite"));
    migrate(sqlite, withExtraMigration("CREATE TABLE `extra` (`id` text);", 1000));
    expect(() => migrate(sqlite, MIGRATIONS)).toThrow(MigrationError);
    sqlite.close();
  });
});
