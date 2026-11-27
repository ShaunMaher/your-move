/**
 * Lazy lobby expiry (docs/spec/02-game-framework.md §4, 06 §6.5). Until the sweep exists (03 §8,
 * M3) nothing expires a lobby on a schedule, so every read or write of a game expires it first if
 * it is overdue, and listing or creating games first expires the user's overdue lobbies: no one
 * sees, accepts or starts a lobby past its 14 days, and its typed addresses are cleared as soon as
 * anyone involved comes back. Expiry is a transition like any other (03 §5.2).
 */
import type { LoadedGame, Repositories } from "../db/repositories.js";
import { expire, LOBBY_LIFETIME_MS } from "./lifecycle.js";
import { memberRow } from "./present.js";

/** Server-started transitions retry this often on `stale` (03 §5.2). */
const ATTEMPTS = 3;
/** At most this many of one user's overdue lobbies are expired per request; the rest next time. */
const OVERDUE_BATCH = 20;

/**
 * The game as it is now, expired first if it is an overdue lobby and `userId` holds a row in it.
 * A stranger's read never writes (it is a `404` anyway). Expiry bumps the version, so a member
 * sees the game unread and an in-flight `expectedVersion` gets `STALE_GAME`. A lost race reloads
 * and looks again; whatever won (a start, a cancel, another expiry) is what the caller sees.
 */
export async function loadCurrent(
  repos: Repositories,
  gameId: string,
  userId: string,
  now: number,
): Promise<LoadedGame | null> {
  for (let attempt = 0; ; attempt++) {
    const loaded = await repos.games.load(gameId);
    if (loaded === null || memberRow(loaded.players, userId) === undefined) return loaded;
    const writes = expire(loaded.game, loaded.players, now);
    if (writes === null) return loaded;
    const result = await repos.games.applyTransition(gameId, loaded.game.version, writes);
    if (result === "ok" || attempt + 1 >= ATTEMPTS) return repos.games.load(gameId);
  }
}

/**
 * Expires the game if it is an overdue lobby, whoever asks: a finished game's rematch that
 * expired may be replaced (05 `POST /api/v1/games/:id/rematch`), and its players needn't be
 * members of it. Retried on `stale` like any server-started transition; whatever won is kept.
 */
export async function expireIfOverdue(
  repos: Repositories,
  gameId: string,
  now: number,
): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const loaded = await repos.games.load(gameId);
    if (loaded === null) return;
    const writes = expire(loaded.game, loaded.players, now);
    if (writes === null) return;
    if ((await repos.games.applyTransition(gameId, loaded.game.version, writes)) === "ok") return;
  }
}

/** Expires the overdue lobbies the user holds a row in (before listing or counting them). */
export async function expireOverdueLobbies(
  repos: Repositories,
  userId: string,
  now: number,
): Promise<void> {
  const ids = await repos.games.overdueLobbies(userId, now - LOBBY_LIFETIME_MS, OVERDUE_BATCH);
  for (const id of ids) await loadCurrent(repos, id, userId, now);
}
