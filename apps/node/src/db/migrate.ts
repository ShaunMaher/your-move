/**
 * Applies the shared SQL migrations (`packages/server/migrations/`, docs/spec/04-data-model.md) at
 * startup, before anything else touches the database (02 §7.3). Cloudflare applies the same files
 * with `wrangler d1 migrations apply` instead (09 §3).
 *
 * - Applied migrations are tracked by their hash in Drizzle's own `__drizzle_migrations` table.
 *   Every known migration whose hash isn't recorded is applied, in journal order; a recorded hash
 *   this build doesn't know (a newer build's migration, or an edited one) refuses the start.
 * - Pending migrations run in one transaction, so a failed one leaves the schema as it was.
 * - Foreign keys are off while they run (04 §Migrations): `PRAGMA foreign_keys` is a no-op inside
 *   a transaction, and with it on, the `DROP TABLE` of drizzle-kit's table rebuilds would fire
 *   every child table's `ON DELETE CASCADE` / `SET NULL`. Before committing,
 *   `PRAGMA foreign_key_check` must come back empty, or the whole migration rolls back.
 */
import type { DatabaseSync } from "node:sqlite";

import { readMigrationFiles } from "drizzle-orm/migrator";

import { inTransaction } from "./sqlite.js";

const TABLE = "__drizzle_migrations";

export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

export interface MigrationOutcome {
  /** Migrations applied by this call. */
  readonly applied: number;
  /** Migrations this build knows; all of them are now applied. */
  readonly known: number;
}

function readMigrations(migrationsFolder: string): ReturnType<typeof readMigrationFiles> {
  try {
    return readMigrationFiles({ migrationsFolder });
  } catch (error) {
    throw new MigrationError(`Cannot read the migrations in ${migrationsFolder}.`, {
      cause: error,
    });
  }
}

/** Brings the database up to this build's schema. */
export function migrate(sqlite: DatabaseSync, migrationsFolder: string): MigrationOutcome {
  const migrations = readMigrations(migrationsFolder);
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS "${TABLE}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
  );
  sqlite.exec("PRAGMA foreign_keys = OFF");
  try {
    return inTransaction(sqlite, () => {
      const recorded = new Set(
        (sqlite.prepare(`SELECT hash FROM "${TABLE}"`).all() as { hash: string }[]).map(
          (row) => row.hash,
        ),
      );
      const known = new Set(migrations.map((migration) => migration.hash));
      if ([...recorded].some((hash) => !known.has(hash))) {
        throw new MigrationError(
          "The database records a migration this build doesn't know: a newer version used it, or a migration was edited after it was applied. Run the newer version, or restore a backup.",
        );
      }
      const pending = migrations.filter((migration) => !recorded.has(migration.hash));
      const record = sqlite.prepare(`INSERT INTO "${TABLE}" (hash, created_at) VALUES (?, ?)`);
      for (const migration of pending) {
        for (const statement of migration.sql) {
          if (statement.trim() !== "") sqlite.exec(statement);
        }
        record.run(migration.hash, migration.folderMillis);
      }
      const violations = sqlite.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new MigrationError(
          `The migrations would leave ${String(violations.length)} row(s) breaking a foreign key; nothing was applied.`,
        );
      }
      return { applied: pending.length, known: migrations.length };
    });
  } finally {
    sqlite.exec("PRAGMA foreign_keys = ON");
  }
}
