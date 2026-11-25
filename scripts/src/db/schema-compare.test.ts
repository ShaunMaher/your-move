import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compareSchemas, describeMigrations } from "./schema-compare.js";

const MIGRATIONS = fileURLToPath(new URL("../../../packages/server/migrations", import.meta.url));
const INIT = "0000_init.sql";

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
  ])("reports a hand edit to %s", (_name, [from, to], fact) => {
    edit(from ?? "", to ?? "");
    expect(differences()).toEqual(
      expect.arrayContaining([expect.stringContaining(fact) as unknown]),
    );
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
