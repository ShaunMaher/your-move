import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compareSchemas, describeMigrations, describeTableClauses } from "./schema-compare.js";

const MIGRATIONS = fileURLToPath(new URL("../../../packages/server/migrations", import.meta.url));
const INIT = "0000_init.sql";

const ADMIN_AUDIT_END =
  "FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null\n);";

let copy: string;

beforeEach(() => {
  copy = mkdtempSync(join(tmpdir(), "schema-compare-"));
  cpSync(MIGRATIONS, copy, { recursive: true });
});

afterEach(() => {
  rmSync(copy, { recursive: true, force: true });
});

/** Edits the copy's first migration, requiring `from` to be there exactly once. */
function edit(from: string, to: string): void {
  const file = join(copy, INIT);
  const text = readFileSync(file, "utf8");
  expect(text.split(from)).toHaveLength(2);
  writeFileSync(file, text.replace(from, to));
}

/** Adds a second migration to the copy's journal. */
function addMigration(sql: string): void {
  const journalFile = join(copy, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalFile, "utf8")) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  journal.entries.push({ idx: 1, when: Date.UTC(2030, 0, 1), tag: "0001_extra" });
  writeFileSync(journalFile, JSON.stringify(journal));
  writeFileSync(join(copy, "0001_extra.sql"), sql);
}

const differences = (): string[] =>
  compareSchemas(describeMigrations(copy), describeMigrations(MIGRATIONS));

describe("compareSchemas over migration folders (P2-2)", () => {
  it("finds nothing between the committed migrations and themselves", () => {
    expect(differences()).toEqual([]);
  });

  it("ignores column order, which ALTER TABLE ADD COLUMN can't follow", () => {
    edit("\t`detail` text,\n", "");
    addMigration("ALTER TABLE `admin_audit` ADD `detail` text;");
    expect(differences()).toEqual([]);
  });

  it.each([
    [
      "a foreign key's ON DELETE action",
      [
        "FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null",
        "FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade",
      ],
      "table admin_audit: foreign key actor_user_id → users.id",
    ],
    ["a column's NOT NULL", ["`action` text NOT NULL,", "`action` text,"], "column action"],
    [
      "a column's default",
      ["`action` text NOT NULL,", "`action` text DEFAULT 'x' NOT NULL,"],
      "column action",
    ],
    [
      "an index's columns",
      [
        "CREATE INDEX `admin_audit_created_at` ON `admin_audit` (`created_at`);",
        "CREATE INDEX `admin_audit_created_at` ON `admin_audit` (`created_at` DESC);",
      ],
      "index admin_audit_created_at",
    ],
    [
      "an index's partial predicate",
      [
        "CREATE INDEX `admin_audit_created_at` ON `admin_audit` (`created_at`);",
        "CREATE INDEX `admin_audit_created_at` ON `admin_audit` (`created_at`) WHERE `detail` IS NULL;",
      ],
      "index admin_audit_created_at",
    ],
    [
      "an index's uniqueness",
      [
        "CREATE INDEX `admin_audit_created_at` ON",
        "CREATE UNIQUE INDEX `admin_audit_created_at` ON",
      ],
      "index admin_audit_created_at",
    ],
    [
      "a column's COLLATE",
      ["`action` text NOT NULL,", "`action` text NOT NULL COLLATE NOCASE,"],
      "table admin_audit: column action: clauses",
    ],
    [
      "a column's CHECK",
      ["`action` text NOT NULL,", "`action` text NOT NULL CHECK (length(`action`) > 0),"],
      "table admin_audit: column action: clauses",
    ],
    [
      "a table's CHECK",
      [ADMIN_AUDIT_END, `CHECK (\`created_at\` > 0),\n\t${ADMIN_AUDIT_END}`],
      "table admin_audit: checks",
    ],
    [
      "a generated column",
      ["`detail` text,", "`detail` text GENERATED ALWAYS AS (`action`) VIRTUAL,"],
      "table admin_audit: column detail",
    ],
    [
      "STRICT",
      [ADMIN_AUDIT_END, ADMIN_AUDIT_END.replace(");", ") STRICT;")],
      "table admin_audit: options",
    ],
    [
      "WITHOUT ROWID",
      [ADMIN_AUDIT_END, ADMIN_AUDIT_END.replace(");", ") WITHOUT ROWID;")],
      "table admin_audit: options",
    ],
    [
      "a foreign key's DEFERRABLE",
      [ADMIN_AUDIT_END, ADMIN_AUDIT_END.replace("\n);", " DEFERRABLE INITIALLY DEFERRED\n);")],
      "table admin_audit: foreign key (actor_user_id) → users: deferrable",
    ],
  ])("reports a hand edit to %s", (_name, [from, to], fact) => {
    edit(from ?? "", to ?? "");
    expect(differences()).toEqual(
      expect.arrayContaining([expect.stringContaining(fact) as unknown]),
    );
  });

  it("tells a generated column from a stored one by table_xinfo's hidden", () => {
    edit("`detail` text,", "`detail` text GENERATED ALWAYS AS (`action`) STORED,");
    expect(describeMigrations(copy).get("table admin_audit: column detail")).toContain(
      '"hidden":3',
    );
  });

  it.each(["sqlite1_purge", "sqliteXpurge", "SQLITE1_purge"])(
    "reports a trigger named %s, which only looks like one of SQLite's own (B1-S-2)",
    (name) => {
      addMigration(
        `CREATE TRIGGER ${name} AFTER INSERT ON \`sessions\` BEGIN DELETE FROM \`sessions\` WHERE 1; END;`,
      );
      expect(differences()).toEqual([
        expect.stringMatching(
          new RegExp(`^trigger ${name} .* is not in schema\\.ts$`, "u"),
        ) as unknown,
      ]);
    },
  );

  it("compares SQLite's own tables too, so AUTOINCREMENT shows as sqlite_sequence", () => {
    edit(
      "`id` text PRIMARY KEY NOT NULL,\n\t`actor_key`",
      "`id` integer PRIMARY KEY AUTOINCREMENT,\n\t`actor_key`",
    );
    expect(differences()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("table sqlite_sequence (exists) is not in schema.ts") as unknown,
      ]),
    );
  });

  it("opens its databases defensively, so writable_schema can't rewrite the schema (B1-S-8)", () => {
    addMigration(
      "PRAGMA writable_schema = 1;\n--> statement-breakpoint\nUPDATE sqlite_schema SET sql = 'CREATE TABLE x (y)' WHERE name = 'admin_audit';",
    );
    expect(() => describeMigrations(copy)).toThrow(/may not be modified/u);
  });

  it("reports a table, index or trigger schema.ts doesn't have, and one it lacks", () => {
    addMigration(
      [
        "CREATE TABLE `extra` (`id` text PRIMARY KEY NOT NULL);",
        "CREATE TRIGGER `extra_touch` AFTER INSERT ON `extra` BEGIN SELECT 1; END;",
        "DROP INDEX `admin_audit_created_at`;",
      ].join("\n--> statement-breakpoint\n"),
    );
    const found = differences();
    expect(found).toContain("table extra (exists) is not in schema.ts");
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^trigger extra_touch .* is not in schema\.ts$/u) as unknown,
        expect.stringMatching(/^index admin_audit_created_at: sql is missing/u) as unknown,
      ]),
    );
  });
});

describe("describeTableClauses (issue #13 S-1)", () => {
  const clauses = (sql: string): Record<string, string> =>
    Object.fromEntries(describeTableClauses(sql));

  it("finds no clauses in drizzle-kit's plain tables", () => {
    expect(
      clauses(
        "CREATE TABLE `t` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`n` integer DEFAULT (CAST(1 AS integer)),\n\t`p` text,\n\tFOREIGN KEY (`p`) REFERENCES `t`(`id`) ON UPDATE no action ON DELETE cascade\n)",
      ),
    ).toEqual({});
  });

  it("reads each column's COLLATE, CHECK and generated expression, and the table's CHECKs", () => {
    expect(
      clauses(
        "CREATE TABLE t (a text COLLATE NOCASE CHECK (a <> 'x'), b text AS (a || 'y') STORED, c int, CONSTRAINT c_positive CHECK (c > 0), CHECK (c < 9))",
      ),
    ).toEqual({
      "column a: clauses": JSON.stringify(["check ( a < > 'x' )", "collate nocase"]),
      "column b: clauses": JSON.stringify(["as ( a | | 'y' ) stored"]),
      checks: JSON.stringify(["check ( c < 9 )", "check ( c > 0 )"]),
    });
  });

  it("ignores comments, quoting, case and spacing, but not a literal's text", () => {
    const plain = "CREATE TABLE t (a text COLLATE nocase CHECK(a<>'X'))";
    const noisy =
      'create table "T" ( "A" TEXT collate NOCASE /* c */ check ( `a` <> \'X\' ) -- d\n)';
    expect(clauses(noisy)).toEqual(clauses(plain));
    expect(clauses(plain.replace("'X'", "'x'"))).not.toEqual(clauses(plain));
    expect(clauses("CREATE TABLE t (b AS (a + 1))")).not.toEqual(
      clauses("CREATE TABLE t (b AS (a + 2))"),
    );
  });

  it("keys a foreign key's DEFERRABLE alike whether it is inline or table-level", () => {
    const inline = clauses(
      "CREATE TABLE t (p text REFERENCES games(id) NOT DEFERRABLE INITIALLY IMMEDIATE)",
    );
    expect(inline).toEqual({
      "foreign key (p) → games: deferrable": JSON.stringify("not deferrable initially immediate"),
    });
    expect(
      clauses(
        "CREATE TABLE t (p text, FOREIGN KEY (`p`) REFERENCES `games`(`id`) NOT DEFERRABLE INITIALLY IMMEDIATE)",
      ),
    ).toEqual(inline);
    expect(
      clauses("CREATE TABLE t (a, b, FOREIGN KEY (a, b) REFERENCES p (x, y) DEFERRABLE)"),
    ).toEqual({ "foreign key (a, b) → p: deferrable": JSON.stringify("deferrable") });
  });

  it("makes no foreign-key fact without a parent table (B1-P-3)", () => {
    expect(clauses("CREATE TABLE t (a text DEFERRABLE, FOREIGN KEY (a) DEFERRABLE)")).toEqual({});
  });

  it("keeps SQL without a column list whole", () => {
    expect(clauses("CREATE VIRTUAL TABLE t USING fts5(a, b)")).toEqual({
      sql: JSON.stringify("create virtual table t using fts5 ( a , b )"),
    });
    expect(Object.keys(clauses("CREATE TABLE t AS SELECT (1) AS a"))).toEqual(["sql"]);
  });
});
