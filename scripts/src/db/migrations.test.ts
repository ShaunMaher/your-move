import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkJournal, journalSchema, lintMigration } from "./migrations.js";
import { lexSql } from "./sql.js";

const MIGRATIONS = fileURLToPath(new URL("../../../packages/server/migrations", import.meta.url));

const entry = (idx: number, when: number, tag: string) => ({ idx, when, tag });

describe("checkJournal", () => {
  it("accepts numbered, increasing entries that match the files", () => {
    const journal = { entries: [entry(0, 10, "0000_a"), entry(1, 20, "0001_b")] };
    expect(checkJournal(journal, ["0000_a.sql", "0001_b.sql"])).toEqual([]);
  });

  it("reports gaps, time going backwards and files that don't match", () => {
    const journal = { entries: [entry(0, 20, "0000_a"), entry(2, 20, "0001_b")] };
    expect(checkJournal(journal, ["0000_a.sql", "0002_c.sql"])).toEqual([
      "journal entry 1 has idx 2",
      `journal entry 0001_b: "when" is not after 0000_a's`,
      "0002_c.sql is not in the journal",
      "the journal names 0001_b.sql, which doesn't exist",
    ]);
  });

  it("holds for the committed migrations", () => {
    const journal = journalSchema.parse(
      JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")),
    );
    const files = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql"));
    expect(checkJournal(journal, files)).toEqual([]);
  });
});

describe("lintMigration (P-1: table rebuilds cascade on D1)", () => {
  const rebuild = [
    "PRAGMA foreign_keys=OFF;",
    "CREATE TABLE `__new_users` (`id` text PRIMARY KEY NOT NULL);",
    "INSERT INTO `__new_users` SELECT `id` FROM `users`;",
    "DROP TABLE `users`;",
    "ALTER TABLE `__new_users` RENAME TO `users`;",
    "PRAGMA foreign_keys=ON;",
  ].join("\n--> statement-breakpoint\n");

  it("refuses drizzle-kit's unreviewed table rebuild", () => {
    expect(lintMigration("0001_x.sql", rebuild)).toEqual([
      expect.stringContaining("0001_x.sql drops a table or changes foreign_keys") as unknown,
    ]);
    expect(lintMigration("0001_x.sql", "drop table t;")).toHaveLength(1);
    expect(lintMigration("0001_x.sql", "PRAGMA foreign_keys = OFF;")).toHaveLength(1);
  });

  it("accepts a reviewed one, and ordinary migrations", () => {
    const reviewed = `-- migration-reviewed: users has no children yet on any instance\n${rebuild}`;
    expect(lintMigration("0001_x.sql", reviewed)).toEqual([]);
    expect(lintMigration("0001_x.sql", "-- migration-reviewed: ok\n" + rebuild)).toHaveLength(1);
    expect(lintMigration("0001_x.sql", "CREATE TABLE t (id text);")).toEqual([]);
  });

  it.each([
    ["a comment inside the keywords", "DROP/**/TABLE `users`;"],
    ["a line comment between them", "DROP --x\nTABLE `users`;"],
    ["a tab and newlines", "drop\t\n table users;"],
    ["a qualified pragma", "PRAGMA main.foreign_keys = OFF;"],
    ["a quoted pragma", 'PRAGMA "foreign_keys" = OFF;'],
    ["a backquoted pragma", "PRAGMA `foreign_keys`=OFF;"],
    ["a quoted schema", 'PRAGMA "main" . foreign_keys = OFF;'],
    ["a comment inside the pragma", "PRAGMA/* x */foreign_keys=OFF;"],
  ])("sees through %s (S2-1)", (_name, sql) => {
    expect(lintMigration("0001_x.sql", sql)).toEqual([
      expect.stringContaining("drops a table or changes foreign_keys") as unknown,
    ]);
  });

  it("takes the review marker only from a real comment, not from a string literal", () => {
    const literal = "INSERT INTO t VALUES ('\n-- migration-reviewed: users has no children');\n";
    expect(lintMigration("0001_x.sql", `${literal}DROP TABLE users;`)).toHaveLength(1);
  });

  it("ignores the patterns inside comments", () => {
    expect(
      lintMigration("0001_x.sql", "-- DROP TABLE users\n/* PRAGMA foreign_keys=OFF */"),
    ).toEqual([]);
  });

  it("passes every committed migration", () => {
    for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql"))) {
      expect(lintMigration(file, readFileSync(join(MIGRATIONS, file), "utf8")), file).toEqual([]);
    }
  });
});

describe("lintMigration (P2-1: no transaction control)", () => {
  it.each([
    "BEGIN;",
    "begin transaction;",
    "COMMIT;",
    "END TRANSACTION;",
    "ROLLBACK;",
    "SAVEPOINT a;",
    "RELEASE a;",
    "/* x */ COMMIT;",
    "-- x\ncommit;",
    "CREATE TABLE t (id text); COMMIT; BEGIN;",
  ])("refuses %j", (sql) => {
    expect(lintMigration("0001_x.sql", sql)).toEqual([
      expect.stringContaining("0001_x.sql begins, ends or nests a transaction") as unknown,
    ]);
  });

  it("refuses it even with a review marker", () => {
    const sql = "-- migration-reviewed: users has no children yet\nCOMMIT;";
    expect(lintMigration("0001_x.sql", sql)).toHaveLength(1);
  });

  it("allows a trigger's BEGIN … END body and the words in literals or identifiers", () => {
    const trigger = [
      "CREATE TRIGGER t_touch AFTER UPDATE ON t BEGIN",
      "  UPDATE t SET n = CASE WHEN n > 0 THEN 1 ELSE 0 END WHERE id = new.id;",
      "  SELECT 1;",
      "END;",
    ].join("\n");
    expect(lintMigration("0001_x.sql", trigger)).toEqual([]);
    expect(lintMigration("0001_x.sql", "INSERT INTO t VALUES ('a; COMMIT; b');")).toEqual([]);
    expect(lintMigration("0001_x.sql", 'CREATE TABLE "x;end" (id text);')).toEqual([]);
  });
});

describe("lexSql", () => {
  it("splits statements, collects comments and collapses whitespace", () => {
    const sql =
      "CREATE  TABLE a (x text);--> statement-breakpoint\n/* c */ CREATE\nINDEX i ON a (x);";
    expect(lexSql(sql)).toEqual({
      statements: ["CREATE TABLE a (x text)", "CREATE INDEX i ON a (x)"],
      comments: ["--> statement-breakpoint", "/* c */"],
    });
  });

  it("keeps quoted text whole, doubled quotes included, and runs unterminated ones to the end", () => {
    expect(lexSql("SELECT 'it''s; -- not a comment';").statements).toEqual([
      "SELECT 'it''s; -- not a comment'",
    ]);
    expect(lexSql("SELECT [a;b], `c;d`; SELECT 'open; ...").statements).toEqual([
      "SELECT [a;b], `c;d`",
      "SELECT 'open; ...",
    ]);
    expect(lexSql("SELECT 1 /* open").comments).toEqual(["/* open"]);
  });
});
