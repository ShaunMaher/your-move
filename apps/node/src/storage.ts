/**
 * The storage half of Node startup (docs/spec/02-game-framework.md §7.3, 09 §4): open the
 * database, apply migrations, then refuse to start while any `lobby`/`active` game would be
 * orphaned by this build's games — checked against `installed.json` only, before any game code is
 * loaded. `ALLOW_ORPHAN_GAMES=true` accepts the orphans for this start; the sweep cancels them.
 */
import type { DatabaseSync } from "node:sqlite";

import { findLiveOrphans, type Installed, type Orphan, type Repositories } from "@your-move/server";

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
  readonly allowOrphanGames: boolean;
}

export interface Storage {
  readonly sqlite: DatabaseSync;
  readonly repos: Repositories;
  readonly migrations: MigrationOutcome;
  /** Orphaned live games accepted with `ALLOW_ORPHAN_GAMES`; empty otherwise. */
  readonly acceptedOrphans: readonly Orphan[];
}

function describeOrphan(orphan: Orphan): string {
  return `game ${orphan.id} (${orphan.gameType} v${String(orphan.gameVersion)}): ${orphan.reason}`;
}

/** Opens and migrates the database and runs the orphan check; throws to refuse the start. */
export async function openStorage(options: StorageOptions): Promise<Storage> {
  const sqlite = openSqlite(options.databasePath);
  try {
    const migrations = migrate(sqlite, options.migrationsFolder);
    const repos = nodeRepositories(sqlite);
    const orphans = await findLiveOrphans(repos.games, options.installed);
    if (orphans.length > 0 && !options.allowOrphanGames) {
      throw new StartupRefusal(
        [
          `Refusing to start: ${String(orphans.length)} live game(s) need a game type or rules version this build doesn't install (02 §7.3).`,
          "Reinstall it, or let the games finish or cancel them first. To accept that they become",
          "orphaned (the sweep cancels them), start once with ALLOW_ORPHAN_GAMES=true.",
          ...orphans.map((orphan) => `  - ${describeOrphan(orphan)}`),
        ].join("\n"),
      );
    }
    return { sqlite, repos, migrations, acceptedOrphans: orphans };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
