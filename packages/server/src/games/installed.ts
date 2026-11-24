/**
 * `generated/installed.json` (docs/spec/02-game-framework.md §7.3): plain data listing each
 * installed game type with its package, version and exported rules versions. Deploy-time and
 * startup orphan checks read only this file, never package code. The core never reads the file
 * itself; runtimes and tools pass its parsed contents in.
 */
import { isGameType } from "@your-move/sdk";
import { z } from "zod";

import type { InstalledGame } from "../app.js";
import type { GameRepo } from "../db/repositories.js";

export const installedSchema = z.record(
  z.string().refine(isGameType, { error: "not a game type id" }),
  z
    .object({
      package: z.string().min(1),
      version: z.string().min(1),
      rulesVersions: z.array(z.number().int().positive()),
      enabledByDefault: z.boolean(),
    })
    .strict(),
);

export type Installed = z.infer<typeof installedSchema>;

/** The one fixed orphan-check query (same SQL on D1 and SQLite). */
export const LIVE_GAMES_QUERY =
  "SELECT id, game_type, game_version FROM games WHERE status IN ('lobby', 'active')";

export const liveGameSchema = z.object({
  id: z.string(),
  game_type: z.string(),
  game_version: z.number().int(),
});

export type LiveGame = z.infer<typeof liveGameSchema>;

export interface Orphan {
  readonly id: string;
  readonly gameType: string;
  readonly gameVersion: number;
  readonly reason: "type not installed" | "rules version not exported";
}

/** Live games that would have no engine with this set of installed games. */
export function findOrphans(games: readonly LiveGame[], installed: Installed): Orphan[] {
  const orphans: Orphan[] = [];
  for (const game of games) {
    const entry = installed[game.game_type];
    const base = { id: game.id, gameType: game.game_type, gameVersion: game.game_version };
    if (entry === undefined) {
      orphans.push({ ...base, reason: "type not installed" });
    } else if (!entry.rulesVersions.includes(game.game_version)) {
      orphans.push({ ...base, reason: "rules version not exported" });
    }
  }
  return orphans;
}

/**
 * The orphan check through the repositories (the Node startup check, 02 §7.3): the same logic as
 * `pnpm games:check-db`, over the same live-game rows.
 */
export async function findLiveOrphans(
  repo: Pick<GameRepo, "liveGames">,
  installed: Installed,
): Promise<Orphan[]> {
  const live = await repo.liveGames();
  return findOrphans(
    live.map((game) => ({ id: game.id, game_type: game.gameType, game_version: game.gameVersion })),
    installed,
  );
}

/**
 * Differences between the loaded registry and `installed.json` (types and rules versions). The
 * Node server refuses to start unless this is empty (02 §7.3).
 */
export function registryMismatches(
  games: readonly InstalledGame[],
  installed: Installed,
): string[] {
  const problems: string[] = [];
  const registry = new Map(
    games.map((game) => [
      game.manifest.type,
      Object.keys(game.engines)
        .map(Number)
        .sort((a, b) => a - b),
    ]),
  );
  for (const [type, versions] of registry) {
    const entry = installed[type];
    if (entry === undefined) {
      problems.push(`registry has game type "${type}", installed.json does not`);
    } else if (versions.join(",") !== [...entry.rulesVersions].sort((a, b) => a - b).join(",")) {
      problems.push(
        `game type "${type}" exports different rules versions than installed.json lists`,
      );
    }
  }
  for (const type of Object.keys(installed)) {
    if (!registry.has(type)) problems.push(`installed.json lists "${type}", the registry does not`);
  }
  return problems;
}
