import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Installed } from "@your-move/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InstanceLockedError } from "./db/instance-lock.js";
import { MigrationError } from "./db/migrate.js";
import { openStorage, StartupRefusal } from "./storage.js";

const MIGRATIONS = fileURLToPath(new URL("../../../packages/server/migrations", import.meta.url));

const INSTALLED: Installed = {
  words: { package: "@x/game-words", version: "1.0.0", rulesVersions: [1], enabledByDefault: true },
};

let dir: string;
let databasePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "storage-"));
  databasePath = join(dir, "app.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const at = Date.UTC(2026, 0, 1);

/** Seeds one game of `type` v1 in `status`, through a first start. */
async function seed(type: string, status: "lobby" | "active" | "finished"): Promise<void> {
  const storage = await openStorage({
    databasePath,
    migrationsFolder: MIGRATIONS,
    installed: INSTALLED,
    allowOrphanGames: false,
  });
  await storage.repos.games.create(
    {
      id: `${type}-${status}`,
      gameType: type,
      gameVersion: 1,
      options: "{}",
      status,
      seats: 2,
      turnTimeoutDays: 3,
      seatOrder: "join",
      aiAssistance: "off",
      lastActionAt: at,
      createdAt: at,
      updatedAt: at,
    },
    [],
  );
  storage.close();
}

describe("openStorage", () => {
  it("migrates a new database and starts with nothing orphaned", async () => {
    const storage = await openStorage({
      databasePath,
      migrationsFolder: MIGRATIONS,
      installed: INSTALLED,
      allowOrphanGames: false,
    });
    expect(storage.migrations).toEqual({ applied: 1, known: 1 });
    expect(storage.acceptedOrphans).toEqual([]);
    storage.close();
  });

  it("refuses to start while a live game's type isn't installed", async () => {
    await seed("gone", "active");
    const start = openStorage({
      databasePath,
      migrationsFolder: MIGRATIONS,
      installed: INSTALLED,
      allowOrphanGames: false,
    });
    await expect(start).rejects.toThrow(StartupRefusal);
    await expect(start).rejects.toThrow(/game gone-active \(gone v1\): type not installed/u);
  });

  it("ignores finished games of a removed type", async () => {
    await seed("gone", "finished");
    const storage = await openStorage({
      databasePath,
      migrationsFolder: MIGRATIONS,
      installed: INSTALLED,
      allowOrphanGames: false,
    });
    expect(storage.migrations.applied).toBe(0);
    expect(storage.acceptedOrphans).toEqual([]);
    storage.close();
  });

  it("accepts the orphans with ALLOW_ORPHAN_GAMES", async () => {
    await seed("gone", "lobby");
    const storage = await openStorage({
      databasePath,
      migrationsFolder: MIGRATIONS,
      installed: INSTALLED,
      allowOrphanGames: true,
    });
    expect(storage.acceptedOrphans).toEqual([
      { id: "gone-lobby", gameType: "gone", gameVersion: 1, reason: "type not installed" },
    ]);
    storage.close();
  });

  it("refuses a second server on the same database, and admits one after the first closes", async () => {
    const options = {
      databasePath,
      migrationsFolder: MIGRATIONS,
      installed: INSTALLED,
      allowOrphanGames: false,
    };
    const first = await openStorage(options);
    await expect(openStorage(options)).rejects.toThrow(InstanceLockedError);
    first.close();
    (await openStorage(options)).close();
  });

  it("closes the database when the migrations can't be read", async () => {
    await expect(
      openStorage({
        databasePath,
        migrationsFolder: join(dir, "missing"),
        installed: INSTALLED,
        allowOrphanGames: false,
      }),
    ).rejects.toThrow(MigrationError);
  });
});
