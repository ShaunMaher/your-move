/**
 * The repository implementations, written once over the shared query code and run by either
 * adapter's {@link Database} (docs/spec/03-architecture.md §4). Multi-statement writes go through
 * one atomic batch; nothing here opens an interactive transaction.
 */
import { and, asc, count, desc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";

import {
  apiTokenRepo,
  authEventRepo,
  otpRepo,
  rateLimitRepo,
  sessionRepo,
  userRepo,
} from "./auth-repos.js";
import { type Database, runBatch, type Statement } from "./database.js";
import { transitionStatements } from "./queries/transition.js";
import type {
  GameRepo,
  GameWriteSet,
  NewGame,
  NewGameExtras,
  NewGamePlayer,
  PublicActionRecord,
  Repositories,
} from "./repositories.js";
import { gameActions, gamePlayers, gameResources, games, invites } from "./schema.js";

/** The `game_actions` columns history may show: never `action` or `rng` (04 invariant 4). */
const PUBLIC_ACTION_COLUMNS = {
  gameId: gameActions.gameId,
  seq: gameActions.seq,
  seat: gameActions.seat,
  kind: gameActions.kind,
  record: gameActions.record,
  describe: gameActions.describe,
  via: gameActions.via,
  createdAt: gameActions.createdAt,
};

/** A `game_players` row that makes its user a member (04 §Membership). */
const IS_MEMBER = or(
  inArray(gamePlayers.state, ["joined", "playing", "out"]),
  and(eq(gamePlayers.state, "invited"), inArray(gamePlayers.delivery, ["normal", "hidden"])),
);

const LIVE = inArray(games.status, ["lobby", "active"]);

/**
 * Players by seat, then in the order their rows were added: the creator, then the invitees as
 * typed, so a lobby lists them stably. SQLite's `rowid` is that order on both drivers.
 */
const PLAYER_ORDER = [asc(gamePlayers.seat), sql`${gamePlayers}.rowid`] as const;

function gameRepo(db: Database): GameRepo {
  return {
    async create(game: NewGame, players: readonly NewGamePlayer[], extras: NewGameExtras = {}) {
      const statements: Statement[] = [
        db.insert(games).values(game),
        ...players.map((player) => db.insert(gamePlayers).values({ ...player, gameId: game.id })),
        ...(extras.resources ?? []).map((resource) =>
          db.insert(gameResources).values({ ...resource, gameId: game.id }),
        ),
        ...(extras.invites ?? []).map((invite) =>
          db.insert(invites).values({ ...invite, gameId: game.id }),
        ),
      ];
      await runBatch(db, statements);
    },
    async get(id) {
      return (await db.select().from(games).where(eq(games.id, id)).get()) ?? null;
    },
    async load(id) {
      const [gameRows, playerRows] = await db.batch([
        db.select().from(games).where(eq(games.id, id)),
        db
          .select()
          .from(gamePlayers)
          .where(eq(gamePlayers.gameId, id))
          .orderBy(...PLAYER_ORDER),
      ]);
      const game = gameRows[0];
      return game === undefined ? null : { game, players: playerRows };
    },
    async players(gameId) {
      return db
        .select()
        .from(gamePlayers)
        .where(eq(gamePlayers.gameId, gameId))
        .orderBy(...PLAYER_ORDER);
    },
    async playersOf(gameIds) {
      if (gameIds.length === 0) return [];
      return db
        .select()
        .from(gamePlayers)
        .where(inArray(gamePlayers.gameId, [...gameIds]))
        .orderBy(asc(gamePlayers.gameId), ...PLAYER_ORDER);
    },
    async resources(gameId) {
      return db
        .select({
          kind: gameResources.kind,
          resourceId: gameResources.resourceId,
          version: gameResources.version,
        })
        .from(gameResources)
        .where(eq(gameResources.gameId, gameId))
        .orderBy(asc(gameResources.kind), asc(gameResources.resourceId));
    },
    async actions(gameId) {
      return db
        .select()
        .from(gameActions)
        .where(eq(gameActions.gameId, gameId))
        .orderBy(asc(gameActions.seq));
    },
    async history(gameId, afterSeq, limit) {
      return db
        .select(PUBLIC_ACTION_COLUMNS)
        .from(gameActions)
        .where(and(eq(gameActions.gameId, gameId), sql`${gameActions.seq} > ${afterSeq}`))
        .orderBy(asc(gameActions.seq))
        .limit(limit);
    },
    async lastActions(gameIds) {
      if (gameIds.length === 0) return [];
      const rows: PublicActionRecord[] = await db
        .select(PUBLIC_ACTION_COLUMNS)
        .from(gameActions)
        .innerJoin(
          games,
          and(eq(games.id, gameActions.gameId), eq(games.actionCount, gameActions.seq)),
        )
        .where(inArray(gameActions.gameId, [...gameIds]));
      return rows;
    },
    async listForUser(query) {
      const ended = sql`coalesce(${games.endedAt}, ${games.updatedAt})`;
      const invitation =
        query.invitations === undefined
          ? // Hidden invitations only in their own list (06 §6.7).
            or(ne(gamePlayers.state, "invited"), ne(gamePlayers.delivery, "hidden"))
          : // Open invitations only: an ended lobby's can't be accepted (A2 review P-1).
            and(
              eq(gamePlayers.state, "invited"),
              eq(gamePlayers.delivery, query.invitations),
              eq(games.status, "lobby"),
            );
      const rows = await db
        .select({ game: games, member: gamePlayers })
        .from(gamePlayers)
        .innerJoin(games, eq(games.id, gamePlayers.gameId))
        .where(
          and(
            eq(gamePlayers.userId, query.userId),
            IS_MEMBER,
            invitation,
            or(
              LIVE,
              and(eq(games.status, "finished"), gte(ended, query.finishedSince)),
              and(
                inArray(games.status, ["declined", "cancelled", "expired"]),
                gte(ended, query.endedSince),
              ),
            ),
            query.status === undefined ? undefined : eq(games.status, query.status),
            query.gameType === undefined ? undefined : eq(games.gameType, query.gameType),
            query.after === undefined
              ? undefined
              : or(
                  lt(games.lastActionAt, query.after.lastActionAt),
                  and(
                    eq(games.lastActionAt, query.after.lastActionAt),
                    lt(games.id, query.after.id),
                  ),
                ),
          ),
        )
        .orderBy(desc(games.lastActionAt), desc(games.id))
        .limit(query.limit);
      return rows;
    },
    async markSeen(gameId, userId, version) {
      await db
        .update(gamePlayers)
        .set({
          lastSeenVersion: sql`max(${gamePlayers.lastSeenVersion}, min(${version}, (SELECT ${games.version} FROM ${games} WHERE ${games.id} = ${gameId})))`,
        })
        .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.userId, userId)));
    },
    async countLiveCreated(userId) {
      const row = await db
        .select({ n: count() })
        .from(games)
        .where(and(eq(games.createdBy, userId), LIVE))
        .get();
      return row?.n ?? 0;
    },
    async countLiveCreatedWithInvite(userId, emailHash) {
      const row = await db
        .select({ n: count(sql`DISTINCT ${games.id}`) })
        .from(invites)
        .innerJoin(games, eq(games.id, invites.gameId))
        .where(
          and(
            eq(invites.inviterId, userId),
            eq(invites.emailHash, emailHash),
            eq(games.createdBy, userId),
            LIVE,
          ),
        )
        .get();
      return row?.n ?? 0;
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
        .where(LIVE);
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
