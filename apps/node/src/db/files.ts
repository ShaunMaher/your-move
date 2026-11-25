/**
 * The database's files are private to the server's user (08, M2a review S-3): the directory is
 * created 0700 and each file 0600 before SQLite opens it. SQLite creates the `-wal` and `-shm`
 * files with the database file's permissions, so they follow.
 */
import { closeSync, constants, fchmodSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The group and other permission bits of the directory holding `path`, as an octal mode string
 * (`"0755"`), or null when it has none. An existing directory keeps its mode, so startup warns
 * about an exposed one rather than changing it (M2a review S2-4).
 */
export function exposedDirectoryMode(path: string): string | null {
  const mode = statSync(dirname(path)).mode & 0o777;
  return (mode & 0o077) === 0 ? null : `0${mode.toString(8).padStart(3, "0")}`;
}

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
