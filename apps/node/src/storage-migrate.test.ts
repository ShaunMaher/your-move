import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrate } from "./db/migrate.js";
import { openStorage } from "./storage.js";

// The connection `migrate` was given, so the test can see which one it was (B1-S2-1).
vi.mock("./db/migrate.js", async (original) => {
  const actual = await original<typeof import("./db/migrate.js")>();
  return { ...actual, migrate: vi.fn(actual.migrate) };
});

const MIGRATIONS = fileURLToPath(new URL("../../../packages/server/migrations", import.meta.url));
const KNOWN = (
  JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: unknown[];
  }
).entries.length;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "storage-migrate-"));
  vi.mocked(migrate).mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const start = (databasePath: string) =>
  openStorage({
    databasePath,
    migrationsFolder: MIGRATIONS,
    installed: {},
    allowOrphanGames: null,
  });

/** The connection the one `migrate` call was given. */
function migrator(): DatabaseSync {
  expect(vi.mocked(migrate)).toHaveBeenCalledTimes(1);
  const connection = vi.mocked(migrate).mock.calls[0]?.[0];
  if (connection === undefined) throw new Error("migrate was not called");
  return connection;
}

describe("openStorage's migration connection (B1-S2-1)", () => {
  it("migrates a database file on a connection of its own, closed before the server's opens", async () => {
    const storage = await start(join(dir, "app.sqlite"));
    expect(storage.migrations).toEqual({ applied: KNOWN, known: KNOWN });
    const connection = migrator();
    // Compared by identity: printing a closed connection would throw.
    expect(connection === storage.sqlite).toBe(false);
    expect(connection.isOpen).toBe(false);
    expect(storage.sqlite.isOpen).toBe(true);
    // The server's connection sees the migrated schema.
    expect(
      storage.sqlite.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'users'").get(),
    ).toEqual({ n: 1 });
    storage.close();
  });

  it("closes the migration connection when a migration fails, and releases the lock", async () => {
    vi.mocked(migrate).mockImplementationOnce(() => {
      throw new Error("planted");
    });
    const path = join(dir, "app.sqlite");
    await expect(start(path)).rejects.toThrow("planted");
    expect(migrator().isOpen).toBe(false);
    // The lock was released: the next start succeeds.
    const storage = await start(path);
    storage.close();
  });

  it("migrates an in-memory database on its one connection", async () => {
    const storage = await start(":memory:");
    expect(migrator() === storage.sqlite).toBe(true);
    storage.close();
  });
});
