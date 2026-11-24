/**
 * The repository implementations, written once over the shared query code and run by either
 * adapter's {@link Database} (docs/spec/03-architecture.md §4). Multi-statement writes go through
 * one atomic batch; nothing here opens an interactive transaction.
 */
import { asc, eq, inArray } from "drizzle-orm";

import {
  apiTokenRepo,
  authEventRepo,
  otpRepo,
  rateLimitRepo,
  sessionRepo,
  userRepo,
} from "./auth-repos.js";
import { type Database, runBatch } from "./database.js";
import { transitionStatements } from "./queries/transition.js";
import type {
  GameRepo,
  GameWriteSet,
  NewGame,
  NewGamePlayer,
  Repositories,
} from "./repositories.js";
import { gameActions, gamePlayers, games } from "./schema.js";

function gameRepo(db: Database): GameRepo {
  return {
    async create(game: NewGame, players: readonly NewGamePlayer[]) {
      await runBatch(db, [
        db.insert(games).values(game),
        ...players.map((player) => db.insert(gamePlayers).values({ ...player, gameId: game.id })),
      ]);
    },
    async get(id) {
      return (await db.select().from(games).where(eq(games.id, id)).get()) ?? null;
    },
    async players(gameId) {
      return db
        .select()
        .from(gamePlayers)
        .where(eq(gamePlayers.gameId, gameId))
        .orderBy(asc(gamePlayers.seat), asc(gamePlayers.id));
    },
    async actions(gameId) {
      return db
        .select()
        .from(gameActions)
        .where(eq(gameActions.gameId, gameId))
        .orderBy(asc(gameActions.seq));
    },
    async applyTransition(gameId: string, expectedVersion: number, writes: GameWriteSet) {
      // A fresh random token per attempt (03 §5.2): a loser's token is never stored, so none of
      // its guarded writes can match.
      const token = crypto.randomUUID();
      const [won] = await runBatch(
        db,
        transitionStatements(db, gameId, expectedVersion, token, writes),
      );
      return Array.isArray(won) && won.length === 1 ? "ok" : "stale";
    },
    async liveGames() {
      return db
        .select({ id: games.id, gameType: games.gameType, gameVersion: games.gameVersion })
        .from(games)
        .where(inArray(games.status, ["lobby", "active"]));
    },
  };
}

/** The repositories over one adapter's database. */
export function createRepositories(db: Database): Repositories {
  return {
    users: userRepo(db),
    games: gameRepo(db),
    otp: otpRepo(db),
    sessions: sessionRepo(db),
    rateLimits: rateLimitRepo(db),
    authEvents: authEventRepo(db),
    apiTokens: apiTokenRepo(db),
  };
}
