/**
 * The database's files are private to the server's user (08, M2a review S-3): the directory is
 * created 0700 and each file 0600 before SQLite opens it. SQLite creates the `-wal` and `-shm`
 * files with the database file's permissions, so they follow.
 */
import { closeSync, constants, fchmodSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/** Creates `path` (and its directory) if missing, and makes it readable by its owner only. */
export function ensurePrivateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR, 0o600);
  try {
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}
