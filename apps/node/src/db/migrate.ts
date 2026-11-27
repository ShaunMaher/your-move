/**
 * Applies the shared SQL migrations (`packages/server/migrations/`, docs/spec/04-data-model.md) at
 * startup, before anything else touches the database (02 §7.3). Cloudflare applies the same files
 * with `wrangler d1 migrations apply` instead (09 §3).
 *
 * - Applied migrations are tracked by their hash in Drizzle's own `__drizzle_migrations` table.
 *   Every known migration whose hash isn't recorded is applied, in journal order; a recorded hash
 *   this build doesn't know (a newer build's migration, or an edited one) refuses the start.
 * - Pending migrations run in one transaction, so a failed one leaves the schema as it was. A
 *   migration may not begin, end or nest a transaction itself, use a pragma other than
 *   `foreign_keys`, attach or detach a database, or create a temporary object: an authorizer
 *   denies those actions while its statements run (`pnpm db:check` refuses such a migration
 *   before it is committed; M2a review P2-1, B1-S-3, B1-S-4, B1-S2-1). Node runs them on a
 *   connection of their own (`storage.ts`).
 * - Foreign keys are off while they run (04 §Migrations): `PRAGMA foreign_keys` is a no-op inside
 *   a transaction, and with it on, the `DROP TABLE` of drizzle-kit's table rebuilds would fire
 *   every child table's `ON DELETE CASCADE` / `SET NULL`. When migrations are pending,
 *   `PRAGMA foreign_key_check` must come back empty before they run (an existing violation is
 *   reported as such) and again before committing, or the whole migration rolls back.
 */
import { constants, type DatabaseSync } from "node:sqlite";

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

const foreignKeyViolations = (sqlite: DatabaseSync): number =>
  sqlite.prepare("PRAGMA foreign_key_check").all().length;

/** The authorizer's actions that create an object with the `TEMP` keyword. */
const TEMPORARY_OBJECTS: ReadonlySet<number> = new Set([
  constants.SQLITE_CREATE_TEMP_TABLE,
  constants.SQLITE_CREATE_TEMP_INDEX,
  constants.SQLITE_CREATE_TEMP_TRIGGER,
  constants.SQLITE_CREATE_TEMP_VIEW,
]);

/**
 * What a migration may not do, by SQLite's authorizer action (04 §Migrations): begin, end or nest
 * a transaction (`BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`), use any pragma but
 * `foreign_keys` (B1-S-3), attach or detach a database (B1-S-4), or create anything in the
 * connection's `temp` schema, with `TEMP` or a `temp.` qualifier (B1-S2-1). The text is what the error says it did.
 */
function deniedAction(action: number, name: string | null, database: string | null): string | null {
  if (action === constants.SQLITE_TRANSACTION || action === constants.SQLITE_SAVEPOINT) {
    return "begins, ends or nests a transaction, which would break the one-transaction guarantee";
  }
  if (action === constants.SQLITE_PRAGMA && name?.toLowerCase() !== "foreign_keys") {
    return "uses a pragma other than foreign_keys";
  }
  if (action === constants.SQLITE_ATTACH || action === constants.SQLITE_DETACH) {
    return "attaches or detaches a database";
  }
  if (TEMPORARY_OBJECTS.has(action)) {
    return "creates a temporary table, index, trigger or view, which would outlive it on its connection";
  }
  // Without the keyword (`CREATE TABLE temp.x`, `CREATE TRIGGER temp.t … ON main.x`) SQLite
  // authorizes an ordinary CREATE, but every temporary object is a row inserted into
  // `temp.sqlite_temp_master` (for a table or view that insert is authorized first, so this is
  // the reason given even with TEMP). Reads and updates of `temp` stay allowed: ALTER TABLE … RENAME
  // reads and rewrites `sqlite_temp_master` even when it is empty.
  if (action === constants.SQLITE_INSERT && database?.toLowerCase() === "temp") {
    return "creates an object in the temp schema, which would outlive it on its connection";
  }
  return null;
}

/**
 * Runs one migration's statements under {@link deniedAction}: a denied statement fails to prepare,
 * however it is written.
 */
function runStatements(sqlite: DatabaseSync, statements: readonly string[], index: number): void {
  const denied: { reason: string | null } = { reason: null };
  sqlite.setAuthorizer((action, name, _detail, database) => {
    const reason = deniedAction(action, name, database);
    if (reason === null) return constants.SQLITE_OK;
    denied.reason ??= reason;
    return constants.SQLITE_DENY;
  });
  try {
    for (const statement of statements) {
      if (statement.trim() !== "") sqlite.exec(statement);
    }
  } catch (error) {
    if (denied.reason === null) throw error;
    throw new MigrationError(
      `Migration ${String(index)} ${denied.reason} (04 §Migrations); nothing was applied.`,
      { cause: error },
    );
  } finally {
    sqlite.setAuthorizer(null);
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
      if (pending.length === 0) return { applied: 0, known: migrations.length };
      const existing = foreignKeyViolations(sqlite);
      if (existing > 0) {
        throw new MigrationError(
          `The database already has ${String(existing)} row(s) breaking a foreign key, before any migration ran; nothing was applied. Repair them (PRAGMA foreign_key_check lists them), or restore a backup.`,
        );
      }
      const record = sqlite.prepare(`INSERT INTO "${TABLE}" (hash, created_at) VALUES (?, ?)`);
      for (const migration of pending) {
        runStatements(sqlite, migration.sql, migrations.indexOf(migration));
        record.run(migration.hash, migration.folderMillis);
      }
      const introduced = foreignKeyViolations(sqlite);
      if (introduced > 0) {
        throw new MigrationError(
          `The migrations would leave ${String(introduced)} row(s) breaking a foreign key; nothing was applied.`,
        );
      }
      return { applied: pending.length, known: migrations.length };
    });
  } finally {
    sqlite.exec("PRAGMA foreign_keys = ON");
  }
}
