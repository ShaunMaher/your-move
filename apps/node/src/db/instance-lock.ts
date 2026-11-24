/**
 * The Node runtime is single-instance by design (docs/spec/03-architecture.md §5.3): a second
 * server on the same database file refuses to start. The lock is SQLite's own exclusive lock on a
 * small file next to the database, held by an open transaction for the life of the process. The
 * operating system releases it when the process exits, however it exits, so a crash never leaves
 * a stale lock behind (a plain lock file would).
 */
import { DatabaseSync } from "node:sqlite";

export class InstanceLockedError extends Error {
  override readonly name = "InstanceLockedError";

  constructor() {
    super(
      "Refusing to start: another server is using this database (03 §5.3). Run one container per DATABASE_PATH.",
    );
  }
}

/** A held instance lock; `release` gives it up (tests, shutdown). */
export interface InstanceLock {
  release(): void;
}

/** The lock file of a database file. */
export function lockPath(databasePath: string): string {
  return `${databasePath}.lock`;
}

/**
 * Takes the instance lock for `databasePath`, or throws {@link InstanceLockedError} at once if
 * another live process (or connection) holds it. An in-memory database needs no lock.
 */
export function acquireInstanceLock(databasePath: string): InstanceLock {
  if (databasePath === ":memory:") return { release: () => undefined };
  const lock = new DatabaseSync(lockPath(databasePath), { timeout: 0 });
  try {
    lock.exec("PRAGMA journal_mode = DELETE");
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    if (error instanceof Error && /locked|busy/iu.test(error.message)) {
      throw new InstanceLockedError();
    }
    throw error;
  }
  return {
    release: () => {
      lock.exec("ROLLBACK");
      lock.close();
    },
  };
}
