import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkJournal, journalSchema, lintMigration } from "./migrations.js";

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

  it("passes every committed migration", () => {
    for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql"))) {
      expect(lintMigration(file, readFileSync(join(MIGRATIONS, file), "utf8")), file).toEqual([]);
    }
  });
});
