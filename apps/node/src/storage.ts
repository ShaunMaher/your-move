/**
 * The storage half of Node startup (docs/spec/02-game-framework.md §7.3, 09 §4): take the
 * single-instance lock, open the database, apply migrations, then refuse to start while any
 * `lobby`/`active` game would be orphaned by this build's games — checked against
 * `installed.json` only, before any game code is loaded.
 *
 * The override is bound to one set of orphans: `ALLOW_ORPHAN_GAMES` must equal the digest the
 * refusal printed for exactly those games, so a value left set can never wave through a later,
 * different set. Until M3 nothing cancels an accepted orphan: it stays in its state, and M3 adds
 * `409 GAME_UNAVAILABLE` and the sweep that cancels it (10 M3).
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { findLiveOrphans, type Installed, type Orphan, type Repositories } from "@your-move/server";

import { exposedDirectoryMode } from "./db/files.js";
import { acquireInstanceLock, type InstanceLock } from "./db/instance-lock.js";
import { migrate, type MigrationOutcome } from "./db/migrate.js";
import { nodeRepositories, openSqlite } from "./db/sqlite.js";

/** A refusal to start whose message names no secret (safe to print as is). */
export class StartupRefusal extends Error {
  override readonly name = "StartupRefusal";
}

export interface StorageOptions {
  readonly databasePath: string;
  readonly migrationsFolder: string;
  readonly installed: Installed;
  /** `ALLOW_ORPHAN_GAMES`: the digest of the accepted orphan set, or null. */
  readonly allowOrphanGames: string | null;
}

export interface Storage {
  readonly sqlite: DatabaseSync;
  readonly repos: Repositories;
  readonly migrations: MigrationOutcome;
  /** Orphaned live games accepted with `ALLOW_ORPHAN_GAMES`; empty otherwise. */
  readonly acceptedOrphans: readonly Orphan[];
  /**
   * The database directory's mode when group or others have any permission on it (startup warns),
   * else null; always null for an in-memory database.
   */
  readonly exposedDirectoryMode: string | null;
  /** Closes the database and releases the instance lock. */
  close(): void;
}

/** The digest naming one set of orphaned games: 12 hex characters of SHA-256 over sorted ids. */
export function orphanDigest(orphans: readonly Orphan[]): string {
  const ids = orphans.map((orphan) => orphan.id).sort();
  return createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 12);
}

function describeOrphan(orphan: Orphan): string {
  return `game ${orphan.id} (${orphan.gameType} v${String(orphan.gameVersion)}): ${orphan.reason}`;
}

function refusal(orphans: readonly Orphan[], digest: string): StartupRefusal {
  return new StartupRefusal(
    [
      `Refusing to start: ${String(orphans.length)} live game(s) need a game type or rules version this build doesn't install (02 §7.3).`,
      "Reinstall it, or let the games finish or cancel them first. To accept that exactly these",
      `games become orphaned, start with ALLOW_ORPHAN_GAMES=${digest} (it accepts only this set).`,
      ...orphans.map((orphan) => `  - ${describeOrphan(orphan)}`),
    ].join("\n"),
  );
}

/**
 * Takes the single-instance lock (03 §5.3), opens and migrates the database and runs the orphan
 * check; throws to refuse the start.
 */
export async function openStorage(options: StorageOptions): Promise<Storage> {
  const lock: InstanceLock = acquireInstanceLock(options.databasePath);
  let sqlite: DatabaseSync | null = null;
  try {
    sqlite = openSqlite(options.databasePath);
    const migrations = migrate(sqlite, options.migrationsFolder);
    const repos = nodeRepositories(sqlite);
    const orphans = await findLiveOrphans(repos.games, options.installed);
    if (orphans.length > 0) {
      const digest = orphanDigest(orphans);
      if (options.allowOrphanGames !== digest) throw refusal(orphans, digest);
    }
    const open = sqlite;
    const close = (): void => {
      open.close();
      lock.release();
    };
    return {
      sqlite,
      repos,
      migrations,
      acceptedOrphans: orphans,
      exposedDirectoryMode:
        options.databasePath === ":memory:" ? null : exposedDirectoryMode(options.databasePath),
      close,
    };
  } catch (error) {
    sqlite?.close();
    lock.release();
    throw error;
  }
}
