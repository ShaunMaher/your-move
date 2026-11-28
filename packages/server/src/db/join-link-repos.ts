/**
 * The join-link repository (docs/spec/04-data-model.md `join_links`, 06 §6.8, alpha A18): one live
 * link per game, stored by the SHA-256 of its token. Creating or rotating a link changes this table
 * only, never the game row (05), and only while the game is a lobby. Written once over the shared
 * schema and run by either adapter's {@link Database}.
 */
import { asc, eq, inArray, lte, sql } from "drizzle-orm";

import type { Database } from "./database.js";
import { guardedInsert } from "./queries/transition.js";
import type { JoinLinkRepo } from "./repositories.js";
import { games, joinLinks } from "./schema.js";

export function joinLinkRepo(db: Database): JoinLinkRepo {
  return {
    async put(gameId, link) {
      // One statement, so a start or another ending of the lobby (which deletes the link in its
      // own batch) either comes after it and deletes it, or before it and stops it.
      const lobby = sql`EXISTS (SELECT 1 FROM ${games} WHERE ${games.id} = ${gameId} AND ${games.status} = 'lobby')`;
      const rows = await guardedInsert(db, joinLinks, { ...link, gameId }, lobby)
        .onConflictDoUpdate({
          target: joinLinks.gameId,
          set: {
            tokenHash: link.tokenHash,
            createdAt: link.createdAt,
            expiresAt: link.expiresAt,
          },
        })
        .returning({ gameId: joinLinks.gameId });
      return rows.length === 1;
    },
    async revoke(gameId) {
      await db.delete(joinLinks).where(eq(joinLinks.gameId, gameId));
    },
    async find(tokenHash) {
      const row = await db
        .select({
          gameId: joinLinks.gameId,
          createdAt: joinLinks.createdAt,
          expiresAt: joinLinks.expiresAt,
        })
        .from(joinLinks)
        .where(eq(joinLinks.tokenHash, tokenHash))
        .get();
      return row ?? null;
    },
    async deleteExpired(now, limit) {
      const due = db
        .select({ gameId: joinLinks.gameId })
        .from(joinLinks)
        .where(lte(joinLinks.expiresAt, now))
        .orderBy(asc(joinLinks.expiresAt), asc(joinLinks.gameId))
        .limit(limit);
      const rows = await db
        .delete(joinLinks)
        .where(inArray(joinLinks.gameId, due))
        .returning({ gameId: joinLinks.gameId });
      return rows.length;
    },
  };
}
