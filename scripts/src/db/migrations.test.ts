import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkJournal, journalSchema, lintMigration } from "./migrations.js";
import { lexSql, migrationReadings } from "./sql.js";

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

describe("lintMigration (issue #13 S-2: dropped columns)", () => {
  it.each([
    ["drizzle-kit's DROP COLUMN", "ALTER TABLE `users` DROP COLUMN `email`;"],
    ["DROP without COLUMN", "alter table users drop email;"],
    ["comments and line breaks", "ALTER/**/TABLE `users`\nDROP -- x\nCOLUMN `email`;"],
    ["a breakpoint before it", "SELECT 1;--> statement-breakpoint\nALTER TABLE users DROP email;"],
  ])("refuses %s without a review line", (_name, sql) => {
    expect(lintMigration("0003_x.sql", sql)).toEqual([
      expect.stringContaining("0003_x.sql drops a column, and its data with it") as unknown,
    ]);
  });

  it("accepts a reviewed one, and an ADD", () => {
    const reviewed = "-- migration-reviewed: email was never written on any instance\n";
    expect(lintMigration("0003_x.sql", `${reviewed}ALTER TABLE users DROP COLUMN email;`)).toEqual(
      [],
    );
    expect(lintMigration("0003_x.sql", "ALTER TABLE `users` ADD `email_id` text;")).toEqual([]);
  });

  it("reports each unreviewed hazard once", () => {
    expect(
      lintMigration("0003_x.sql", "DROP TABLE a;\nALTER TABLE b DROP c;\nALTER TABLE d DROP e;"),
    ).toEqual([
      expect.stringContaining("drops a table") as unknown,
      expect.stringContaining("drops a column") as unknown,
    ]);
  });
});

const AFTER_BREAKPOINT = 'has text after "--> statement-breakpoint"';
const UNTERMINATED = "has an unterminated block comment, string or quoted identifier";
const DISAGREE = "reads as different statements on D1";

/** `problems` contains exactly these fragments, one problem each, in this order. */
const exactly = (...fragments: string[]): unknown[] =>
  fragments.map((fragment) => expect.stringContaining(fragment) as unknown);

describe("lintMigration (issue #13 R-2, B1-S-1: both readings must agree)", () => {
  it("ends a statement at a breakpoint, as Node's migrator does", () => {
    // A trigger with no `;` after its END: SQLite would read COMMIT as part of it, Node doesn't.
    const sql =
      "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END\n--> statement-breakpoint\nCOMMIT;";
    expect(lintMigration("0003_x.sql", sql)).toEqual(
      exactly(DISAGREE, "begins, ends or nests a transaction"),
    );
  });

  it("refuses two statements a breakpoint separates without a `;`", () => {
    const sql = "CREATE TABLE a (x text)\n--> statement-breakpoint\nCREATE TABLE b (y text);";
    expect(lintMigration("0003_x.sql", sql)).toEqual(exactly(DISAGREE));
  });

  it.each([
    ["a statement", "CREATE TABLE a (x int);\n--> statement-breakpoint DELETE FROM a;\n"],
    ["a comment", "SELECT 1;--> statement-breakpoint -- note\nSELECT 2;"],
    ["a CR alone", "SELECT 1;--> statement-breakpoint\rSELECT 2;"],
  ])("refuses %s after a breakpoint on its line", (_name, sql) => {
    expect(lintMigration("0003_x.sql", sql)).toEqual(
      expect.arrayContaining(exactly(AFTER_BREAKPOINT)),
    );
  });

  it("names the line of the breakpoint with text after it", () => {
    const sql = "SELECT 1;\r\n--> statement-breakpoint\r\nSELECT 2;--> statement-breakpoint x\n";
    expect(lintMigration("0003_x.sql", sql)).toEqual(
      expect.arrayContaining([expect.stringContaining("on line 3") as unknown]),
    );
  });

  it.each([
    [
      "a block comment",
      "CREATE TABLE a (x int);\n/* note\n--> statement-breakpoint\nDELETE FROM a;\n",
    ],
    ["a block comment at the end", "SELECT 1; /* note"],
    ["a string", "SELECT 'open;"],
    ["a quoted identifier", 'SELECT "open;'],
    ["a backquoted identifier", "SELECT `open;"],
    ["a bracketed identifier", "SELECT [open;"],
  ])("refuses %s left unterminated", (_name, sql) => {
    expect(lintMigration("0003_x.sql", sql)).toEqual(expect.arrayContaining(exactly(UNTERMINATED)));
  });

  it("sees a statement a breakpoint lets out of a comment or a literal on Node", () => {
    for (const sql of [
      "/* --> statement-breakpoint\nDROP TABLE users; /* */",
      "SELECT '--> statement-breakpoint\nDROP TABLE users; --';",
    ]) {
      expect(lintMigration("0003_x.sql", sql), sql).toEqual(
        exactly(UNTERMINATED, DISAGREE, "drops a table"),
      );
    }
  });

  it("takes a review line only when it is a comment in both readings", () => {
    // On Node the breakpoint turns the line into a `--` comment; on D1 it is inside /* … */.
    const sql =
      "/* --> statement-breakpoint\n-- migration-reviewed: users has no children yet */\nDROP TABLE users;";
    expect(lintMigration("0003_x.sql", sql)).toEqual(
      expect.arrayContaining(exactly("drops a table")),
    );
  });

  it("accepts drizzle-kit's layout: breakpoints at line ends or the end of the file", () => {
    const sql =
      "CREATE TABLE a (x int);--> statement-breakpoint\nCREATE INDEX i ON a (x);\r\n--> statement-breakpoint\r\nSELECT 1;--> statement-breakpoint";
    expect(lintMigration("0003_x.sql", sql)).toEqual([]);
  });
});

describe("lintMigration (R-3, B1-S-7: characters and line endings)", () => {
  it("accepts a review line in a CRLF file", () => {
    const sql =
      "-- migration-reviewed: users has no children yet\r\nDROP TABLE `users`;\r\n--> statement-breakpoint\r\nSELECT 1;\r\n";
    expect(lintMigration("0003_x.sql", sql)).toEqual([]);
  });

  it("accepts tabs", () => {
    expect(lintMigration("0003_x.sql", "CREATE TABLE a (\n\t`x` int\n);")).toEqual([]);
  });

  it.each([
    ["a no-break space", "DROP\u00a0TABLE a;", "U+00A0 on line 1"],
    ["a byte-order mark", "\ufeffSELECT 1;", "U+FEFF on line 1"],
    ["a CR alone", "-- migration-reviewed: this is reviewed ok\rDROP TABLE a;", "U+000D on line 1"],
    ["a form feed", "SELECT 1;\r\n\fSELECT 2;", "U+000C on line 2"],
    ["a NUL", "SELECT 1;\0", "U+0000 on line 1"],
    [
      "an emoji in a literal",
      "SELECT 1;\nINSERT INTO a VALUES ('\u{1F600}');",
      "U+1F600 on line 2",
    ],
    ["a replacement character (bytes that weren't UTF-8)", "SELECT '\ufffd';", "U+FFFD on line 1"],
  ])("refuses %s", (_name, sql, where) => {
    expect(lintMigration("0003_x.sql", sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `0003_x.sql has ${where}: a migration is printable ASCII`,
        ) as unknown,
      ]),
    );
  });
});

describe("lintMigration (B1-S-3, B1-S-4: refused statements)", () => {
  const reviewed = "-- migration-reviewed: users has no children on any instance\n";

  it.each([
    "PRAGMA writable_schema = 1;",
    "PRAGMA defer_foreign_keys = ON;",
    'PRAGMA main."legacy_alter_table" = 1;',
    "PRAGMA foreign_key_check;",
    "pragma journal_mode=DELETE;",
    "EXPLAIN PRAGMA writable_schema = 1;",
    "EXPLAIN QUERY PLAN PRAGMA writable_schema = 1;",
    "/* x */ PRAGMA trusted_schema = 1;",
  ])("refuses %j, review line or not", (sql) => {
    for (const text of [sql, `${reviewed}${sql}`]) {
      expect(lintMigration("0003_x.sql", text)).toEqual(
        exactly("0003_x.sql uses a pragma other than foreign_keys"),
      );
    }
  });

  it.each([
    "PRAGMA foreign_keys=OFF;",
    'PRAGMA main."foreign_keys" = ON;',
    "PRAGMA foreign_keys(0);",
    "EXPLAIN PRAGMA foreign_keys = OFF;",
  ])("allows %j with a review line only, as the rebuild rule says", (sql) => {
    expect(lintMigration("0003_x.sql", sql)).toEqual(exactly("changes foreign_keys"));
    expect(lintMigration("0003_x.sql", `${reviewed}${sql}`)).toEqual([]);
  });

  it.each([
    "ATTACH DATABASE ':memory:' AS aux;",
    "attach ':memory:' as aux;",
    "DETACH DATABASE aux;",
    "VACUUM;",
    "VACUUM INTO 'copy.db';",
    "EXPLAIN VACUUM;",
  ])("refuses %j, review line or not", (sql) => {
    for (const text of [sql, `${reviewed}${sql}`]) {
      expect(lintMigration("0003_x.sql", text)).toEqual(
        exactly("0003_x.sql attaches, detaches or vacuums a database"),
      );
    }
  });

  it("leaves the words alone inside literals and identifiers", () => {
    expect(
      lintMigration("0003_x.sql", "INSERT INTO t VALUES ('PRAGMA x; ATTACH y; VACUUM');"),
    ).toEqual([]);
    expect(lintMigration("0003_x.sql", 'CREATE TABLE "vacuum" ("pragma" text);')).toEqual([]);
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
      unterminated: false,
    });
  });

  it("leaves a CRLF line ending out of a line comment", () => {
    expect(lexSql("-- a\r\nSELECT 1; -- b\r").comments).toEqual(["-- a", "-- b"]);
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

describe("migrationReadings", () => {
  it("reads the file whole and cut at every breakpoint", () => {
    const [whole, cut] = migrationReadings("SELECT '--> statement-breakpoint'; SELECT 2;");
    expect(whole?.statements).toEqual(["SELECT '--> statement-breakpoint'", "SELECT 2"]);
    expect(cut?.statements).toEqual(["SELECT '", "'; SELECT 2;"]);
  });
});
