import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openStorage } from "../storage.js";
import { lockPath } from "./instance-lock.js";

const MIGRATIONS = fileURLToPath(
  new URL("../../../../packages/server/migrations", import.meta.url),
);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "files-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("database file modes (M2a review S-3)", () => {
  it("creates the directory 0700 and the database, WAL, SHM and lock files 0600", async () => {
    const database = join(dir, "data", "app.sqlite");
    const storage = await openStorage({
      databasePath: database,
      migrationsFolder: MIGRATIONS,
      installed: {},
      allowOrphanGames: null,
    });
    try {
      expect(mode(join(dir, "data"))).toBe(0o700);
      for (const file of [database, `${database}-wal`, `${database}-shm`, lockPath(database)]) {
        expect(mode(file), file).toBe(0o600);
      }
    } finally {
      storage.close();
    }
  });

  it("tightens an existing database file that others could read", async () => {
    const database = join(dir, "app.sqlite");
    writeFileSync(database, "");
    chmodSync(database, 0o644);
    const storage = await openStorage({
      databasePath: database,
      migrationsFolder: MIGRATIONS,
      installed: {},
      allowOrphanGames: null,
    });
    storage.close();
    expect(mode(database)).toBe(0o600);
  });
});
