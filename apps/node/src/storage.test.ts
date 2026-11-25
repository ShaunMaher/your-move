import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Installed, Orphan } from "@your-move/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InstanceLockedError } from "./db/instance-lock.js";
import { MigrationError } from "./db/migrate.js";
import { openStorage, orphanDigest, StartupRefusal } from "./storage.js";

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

/** Seeds one game of `type` v1 in `status`, through a start accepting `allowOrphanGames`. */
async function seed(
  type: string,
  status: "lobby" | "active" | "finished",
  allowOrphanGames: string | null = null,
): Promise<void> {
  const storage = await openStorage({
    databasePath,
    migrationsFolder: MIGRATIONS,
    installed: INSTALLED,
    allowOrphanGames,
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
      allowOrphanGames: null,
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
      allowOrphanGames: null,
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
      allowOrphanGames: null,
    });
    expect(storage.migrations.applied).toBe(0);
    expect(storage.acceptedOrphans).toEqual([]);
    storage.close();
  });

  it("accepts exactly the orphan set ALLOW_ORPHAN_GAMES names, and no other", async () => {
    await seed("gone", "lobby");
    const options = { databasePath, migrationsFolder: MIGRATIONS, installed: INSTALLED };
    const digest = orphanDigest([
      { id: "gone-lobby", gameType: "gone", gameVersion: 1, reason: "type not installed" },
    ]);
    // The refusal prints the digest to use.
    await expect(openStorage({ ...options, allowOrphanGames: null })).rejects.toThrow(
      `ALLOW_ORPHAN_GAMES=${digest}`,
    );
    // Another set's digest (a value left over from an earlier start) doesn't match.
    await expect(openStorage({ ...options, allowOrphanGames: orphanDigest([]) })).rejects.toThrow(
      StartupRefusal,
    );
    const storage = await openStorage({ ...options, allowOrphanGames: digest });
    expect(storage.acceptedOrphans).toEqual([
      { id: "gone-lobby", gameType: "gone", gameVersion: 1, reason: "type not installed" },
    ]);
    storage.close();
  });

  it("refuses a subset's digest when more games are orphaned (P2-8)", async () => {
    const lobby: Orphan = {
      id: "gone-lobby",
      gameType: "gone",
      gameVersion: 1,
      reason: "type not installed",
    };
    const active = { ...lobby, id: "gone-active" };
    await seed("gone", "lobby");
    await seed("gone", "active", orphanDigest([lobby]));
    const options = { databasePath, migrationsFolder: MIGRATIONS, installed: INSTALLED };
    // {A}'s digest, accepted while A was the only orphan, doesn't wave through {A, B}.
    const start = openStorage({ ...options, allowOrphanGames: orphanDigest([lobby]) });
    await expect(start).rejects.toThrow(StartupRefusal);
    await expect(start).rejects.toThrow(`ALLOW_ORPHAN_GAMES=${orphanDigest([lobby, active])}`);
    const storage = await openStorage({
      ...options,
      allowOrphanGames: orphanDigest([active, lobby]),
    });
    expect(storage.acceptedOrphans.map((orphan) => orphan.id).sort()).toEqual([
      "gone-active",
      "gone-lobby",
    ]);
    storage.close();
  });

  it("refuses a second server on the same database, and admits one after the first closes", async () => {
    const options = {
      databasePath,
      migrationsFolder: MIGRATIONS,
      installed: INSTALLED,
      allowOrphanGames: null,
    };
    const first = await openStorage(options);
    await expect(openStorage(options)).rejects.toThrow(InstanceLockedError);
    first.close();
    (await openStorage(options)).close();
  });

  it("closes the database and releases the lock when the migrations can't be read", async () => {
    await expect(
      openStorage({
        databasePath,
        migrationsFolder: join(dir, "missing"),
        installed: INSTALLED,
        allowOrphanGames: null,
      }),
    ).rejects.toThrow(MigrationError);
    // The same path opens again at once: nothing was left open or locked.
    (
      await openStorage({
        databasePath,
        migrationsFolder: MIGRATIONS,
        installed: INSTALLED,
        allowOrphanGames: null,
      })
    ).close();
  });
});
