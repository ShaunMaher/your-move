import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
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

/** How many migrations the repository has; tests add theirs after the last. */
const KNOWN = (
  JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: unknown[];
  }
).entries.length;

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

let copies = 0;

/**
 * A fresh copy of the migrations folder with one more migration, `millis` after the last, and
 * optionally others (in journal order before it).
 */
function withExtraMigration(
  sql: string,
  millis: number,
  others: readonly { sql: string; millis: number }[] = [],
): string {
  copies += 1;
  const folder = join(dir, `migrations-${String(copies)}`);
  cpSync(MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
  };
  const last = journal.entries.at(-1);
  if (last === undefined) throw new Error("no migrations");
  for (const extra of [...others, { sql, millis }]) {
    const idx = journal.entries.length;
    const tag = `000${String(idx)}_extra`;
    journal.entries.push({ ...last, idx, when: last.when + extra.millis, tag });
    writeFileSync(join(folder, `${tag}.sql`), extra.sql);
  }
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

describe("migrate", () => {
  it("creates every table of the data model, then has nothing left to do", () => {
    const path = join(dir, "app.sqlite");
    const sqlite = openSqlite(path);
    expect(migrate(sqlite, MIGRATIONS)).toEqual({ applied: KNOWN, known: KNOWN });
    expect(migrate(sqlite, MIGRATIONS)).toEqual({ applied: 0, known: KNOWN });
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
    expect(migrate(sqlite, folder)).toEqual({ applied: 1, known: KNOWN + 1 });
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

  it("refuses a migration edited after it was applied", () => {
    const sqlite = openSqlite(join(dir, "app.sqlite"));
    migrate(sqlite, withExtraMigration("CREATE TABLE `extra` (`id` text);", 1000));
    const edited = withExtraMigration("CREATE TABLE `extra` (`id` text, `more` text);", 1000);
    expect(() => migrate(sqlite, edited)).toThrow(/doesn't know/u);
    sqlite.close();
  });

  it("applies a migration it hasn't recorded even when a later one is applied", () => {
    // Two branches each add a migration; the one merged second has the earlier timestamp.
    const sqlite = openSqlite(join(dir, "app.sqlite"));
    migrate(sqlite, withExtraMigration("CREATE TABLE `late` (`id` text);", 2000));
    const both = withExtraMigration("CREATE TABLE `late` (`id` text);", 2000, [
      { sql: "CREATE TABLE `early` (`id` text);", millis: 1000 },
    ]);
    expect(migrate(sqlite, both)).toEqual({ applied: 1, known: KNOWN + 2 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM early").get()).toEqual({ n: 0 });
    sqlite.close();
  });

  it("keeps every child row when a migration rebuilds a parent table (M2a review P-1)", () => {
    const sqlite = openSqlite(join(dir, "app.sqlite"));
    migrate(sqlite, MIGRATIONS);
    seedFamily(sqlite);
    const before = familyCounts(sqlite);
    expect(before).toEqual({ users: 1, sessions: 1, gamesByCreator: 1, seatsOfUser: 1 });
    expect(migrate(sqlite, withExtraMigration(rebuildUsers(sqlite), 1000)).applied).toBe(1);
    expect(familyCounts(sqlite)).toEqual(before);
    expect(sqlite.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    sqlite.close();
  });

  it("rolls back a migration that would leave a broken foreign key", () => {
    const sqlite = openSqlite(join(dir, "app.sqlite"));
    migrate(sqlite, MIGRATIONS);
    const folder = withExtraMigration(
      "INSERT INTO `sessions` VALUES ('s2', 'nobody', 'h2', 0, 0, 0, NULL);",
      1000,
    );
    expect(() => migrate(sqlite, folder)).toThrow(/migrations would leave 1 row\(s\) breaking/u);
    expect(sqlite.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    sqlite.close();
  });

  describe("a foreign key already broken before the migrations (P2-3)", () => {
    function breakForeignKey(sqlite: DatabaseSync): void {
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.exec("INSERT INTO `sessions` VALUES ('s2', 'nobody', 'h2', 0, 0, 0, NULL)");
      sqlite.exec("PRAGMA foreign_keys = ON");
    }

    it("doesn't stop a start with nothing to migrate", () => {
      const sqlite = openSqlite(join(dir, "app.sqlite"));
      migrate(sqlite, MIGRATIONS);
      breakForeignKey(sqlite);
      expect(migrate(sqlite, MIGRATIONS)).toEqual({ applied: 0, known: KNOWN });
      sqlite.close();
    });

    it("is reported as already there, not blamed on the pending migrations", () => {
      const sqlite = openSqlite(join(dir, "app.sqlite"));
      migrate(sqlite, MIGRATIONS);
      breakForeignKey(sqlite);
      const folder = withExtraMigration("CREATE TABLE `extra` (`id` text);", 1000);
      expect(() => migrate(sqlite, folder)).toThrow(
        /already has 1 row\(s\) breaking a foreign key, before any migration ran/u,
      );
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'extra'").get(),
      ).toEqual({ n: 0 });
      sqlite.close();
    });
  });

  describe("transaction control in a migration (P2-1)", () => {
    it.each([
      "COMMIT;",
      "END;",
      "/* hidden */ COMMIT;",
      "-- hidden\nCOMMIT;",
      "COMMIT; BEGIN;",
      "ROLLBACK;",
      "SAVEPOINT s;",
      "SAVEPOINT s; RELEASE s;",
      "BEGIN;",
    ])("refuses %j and applies nothing", (statement) => {
      const sqlite = openSqlite(join(dir, "app.sqlite"));
      const folder = withExtraMigration(
        `CREATE TABLE \`extra\` (\`id\` text);\n--> statement-breakpoint\n${statement}`,
        1000,
      );
      expect(() => migrate(sqlite, folder)).toThrow(
        new RegExp(`Migration ${String(KNOWN)} begins, ends or nests a transaction`, "u"),
      );
      expect(sqlite.isTransaction).toBe(false);
      expect(
        sqlite
          .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('users', 'extra')")
          .get(),
      ).toEqual({ n: 0 });
      // The authorizer is gone again: the connection's own transactions still work.
      sqlite.exec("BEGIN; COMMIT;");
      sqlite.close();
    });

    it("allows a trigger's BEGIN … END body", () => {
      const sqlite = openSqlite(join(dir, "app.sqlite"));
      const folder = withExtraMigration(
        "CREATE TABLE `extra` (`id` text);\n--> statement-breakpoint\nCREATE TRIGGER `extra_t` AFTER INSERT ON `extra` BEGIN SELECT 1; END;",
        1000,
      );
      expect(migrate(sqlite, folder)).toEqual({ applied: KNOWN + 1, known: KNOWN + 1 });
      sqlite.close();
    });
  });
});

/** One user with a session, a game they created and a seat in it. */
function seedFamily(sqlite: DatabaseSync): void {
  sqlite.exec(`
    INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'a@example.org', 0, 0);
    INSERT INTO sessions VALUES ('s1', 'u1', 'h1', 0, 0, 0, NULL);
    INSERT INTO games (id, game_type, game_version, options, status, created_by, seats,
      turn_timeout_days, seat_order, ai_assistance, last_action_at, created_at, updated_at)
      VALUES ('g1', 'words', 1, '{}', 'lobby', 'u1', 2, 3, 'join', 'off', 0, 0, 0);
    INSERT INTO game_players (id, game_id, user_id, state) VALUES ('p1', 'g1', 'u1', 'joined');
  `);
}

function familyCounts(sqlite: DatabaseSync): Record<string, unknown> {
  const count = (sql: string): unknown => (sqlite.prepare(sql).get() as { n: number }).n;
  return {
    users: count("SELECT count(*) AS n FROM users"),
    sessions: count("SELECT count(*) AS n FROM sessions WHERE user_id = 'u1'"),
    gamesByCreator: count("SELECT count(*) AS n FROM games WHERE created_by = 'u1'"),
    seatsOfUser: count("SELECT count(*) AS n FROM game_players WHERE user_id = 'u1'"),
  };
}

/**
 * A test-only migration shaped like drizzle-kit's table rebuild of `users` (the table every
 * cascade hangs off): copy into `__new_users`, drop `users`, rename.
 */
function rebuildUsers(sqlite: DatabaseSync): string {
  const { sql } = sqlite
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'users'")
    .get() as { sql: string };
  return [
    "PRAGMA foreign_keys=OFF;",
    `${sql.replace("CREATE TABLE `users`", "CREATE TABLE `__new_users`")};`,
    "INSERT INTO `__new_users` SELECT * FROM `users`;",
    "DROP TABLE `users`;",
    "ALTER TABLE `__new_users` RENAME TO `users`;",
    "PRAGMA foreign_keys=ON;",
  ].join("\n--> statement-breakpoint\n");
}
