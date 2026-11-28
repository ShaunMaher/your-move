/**
 * The statements of one game transition (docs/spec/03-architecture.md §5.2). Statement 1 bumps the
 * version and stores a fresh write token only if the game is still at the expected version; every
 * dependent write is guarded by that token, so only the winner's writes can take effect:
 *
 *   UPDATE games SET ..., version = version + 1, write_token = :token
 *     WHERE id = :id AND version = :expected RETURNING id
 *   INSERT INTO game_actions (...) SELECT ... WHERE (SELECT write_token FROM games WHERE id = :id) = :token
 *   UPDATE game_players SET ... WHERE id = ? AND game_id = :id
 *     AND (SELECT write_token FROM games WHERE id = :id) = :token
 *
 * A guard on the version would be wrong both ways: `version = expected` skips the winner's own
 * dependent writes, `version = expected + 1` lets the loser's through.
 */
import { and, eq, getTableColumns, is, SQL, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import type { Database, Statement } from "../database.js";
import type { GameWriteSet } from "../repositories.js";
import { blocks, gameActions, gamePlayers, games, joinLinks, pastOpponents } from "../schema.js";

/** True only while `token` is the game's stored write token: this transition won. */
export function tokenGuard(gameId: string, token: string): SQL {
  return sql`(SELECT ${games.writeToken} FROM ${games} WHERE ${games.id} = ${gameId}) = ${token}`;
}

/**
 * `INSERT INTO <table> (<every column>) SELECT <values> WHERE <guard>`: inserts `row` only while
 * the guard holds. Drizzle lists every column of the table for an insert-select, so a column left
 * out of `row` gets its schema default (or NULL); values go through each column's driver mapping,
 * exactly as a plain insert would.
 */
export function guardedInsert<T extends SQLiteTable>(
  db: Database,
  table: T,
  row: T["$inferInsert"],
  guard: SQL,
) {
  const given = row as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!(key in getTableColumns(table))) throw new Error(`unknown column "${key}"`);
  }
  const values = Object.entries(getTableColumns(table)).map(([key, column]) => {
    const value: unknown =
      given[key] !== undefined
        ? given[key]
        : column.hasDefault
          ? (column.default as unknown)
          : null;
    return is(value, SQL) ? value : sql.param(value, column);
  });
  return db.insert(table).select(sql`SELECT ${sql.join(values, sql`, `)} WHERE ${guard}`);
}

/** No block in either direction between the two users (04 invariant 6). */
export function unblocked(a: string, b: string): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM ${blocks} WHERE (${blocks.blockerId} = ${a} AND ${blocks.blockedId} = ${b}) OR (${blocks.blockerId} = ${b} AND ${blocks.blockedId} = ${a}))`;
}

/** The statements of one transition, statement 1 first. */
export function transitionStatements(
  db: Database,
  gameId: string,
  expectedVersion: number,
  token: string,
  writes: GameWriteSet,
): [Statement, ...Statement[]] {
  const guard = tokenGuard(gameId, token);
  const link = writes.requireJoinLink;
  const first = db
    .update(games)
    .set({ ...writes.game, version: sql`${games.version} + 1`, writeToken: token })
    .where(
      and(
        eq(games.id, gameId),
        eq(games.version, expectedVersion),
        link === undefined
          ? undefined
          : sql`EXISTS (SELECT 1 FROM ${joinLinks} WHERE ${joinLinks.gameId} = ${gameId} AND ${joinLinks.tokenHash} = ${link.tokenHash} AND ${joinLinks.expiresAt} > ${link.now})`,
      ),
    )
    .returning({ id: games.id });
  const dependent: Statement[] = [
    ...(writes.insertPlayers ?? []).map((player) =>
      guardedInsert(db, gamePlayers, { ...player, gameId }, guard),
    ),
    ...(writes.updatePlayers ?? []).map(({ id, set }) =>
      db
        .update(gamePlayers)
        .set(set)
        .where(and(eq(gamePlayers.id, id), eq(gamePlayers.gameId, gameId), guard)),
    ),
    ...(writes.insertActions ?? []).map((action) =>
      guardedInsert(db, gameActions, { ...action, gameId }, guard),
    ),
    ...(writes.pastOpponents ?? []).map((pair) =>
      guardedInsert(
        db,
        pastOpponents,
        pair,
        and(guard, unblocked(pair.userId, pair.otherId)) ?? guard,
      ).onConflictDoUpdate({
        target: [pastOpponents.userId, pastOpponents.otherId],
        set: { lastFinishedAt: pair.lastFinishedAt },
      }),
    ),
    ...(writes.deleteJoinLink === true
      ? [db.delete(joinLinks).where(and(eq(joinLinks.gameId, gameId), guard))]
      : []),
  ];
  return [first, ...dependent];
}
