/**
 * Applies the shared SQL migrations (`packages/server/migrations/`, docs/spec/04-data-model.md) at
 * startup, before anything else touches the database (02 §7.3). Pending migrations run in one
 * transaction, so a failed one leaves the schema as it was. Applied migrations are tracked in
 * Drizzle's own `__drizzle_migrations` table and format, so Drizzle's migrator could take over.
 *
 * Cloudflare applies the same files with `wrangler d1 migrations apply` instead (09 §3).
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

/** Brings the database up to this build's schema. */
export function migrate(sqlite: DatabaseSync, migrationsFolder: string): MigrationOutcome {
  let migrations: ReturnType<typeof readMigrationFiles>;
  try {
    migrations = readMigrationFiles({ migrationsFolder });
  } catch (error) {
    throw new MigrationError(`Cannot read the migrations in ${migrationsFolder}.`, {
      cause: error,
    });
  }
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS "${TABLE}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
  );
  return inTransaction(sqlite, () => {
    const last = sqlite
      .prepare(`SELECT created_at FROM "${TABLE}" ORDER BY created_at DESC LIMIT 1`)
      .get() as { created_at: number | string } | undefined;
    const lastMillis = last === undefined ? null : Number(last.created_at);
    const newest = migrations.at(-1)?.folderMillis ?? 0;
    if (lastMillis !== null && lastMillis > newest) {
      throw new MigrationError(
        "The database has migrations this build doesn't know: it was used by a newer version. Restore a backup or run the newer version.",
      );
    }
    const pending = migrations.filter(
      (migration) => lastMillis === null || migration.folderMillis > lastMillis,
    );
    const record = sqlite.prepare(`INSERT INTO "${TABLE}" (hash, created_at) VALUES (?, ?)`);
    for (const migration of pending) {
      for (const statement of migration.sql) {
        if (statement.trim() !== "") sqlite.exec(statement);
      }
      record.run(migration.hash, migration.folderMillis);
    }
    return { applied: pending.length, known: migrations.length };
  });
}
