/**
 * The invite-claim repository (docs/spec/06-auth.md §6.4, 02 §4 Invite claims, alpha A17): which
 * email-invite seats an address may claim, which ones the sweep claims, and the claim itself, a
 * guarded update of one `game_players` row that checks the game's version without bumping it.
 * Written once over the shared schema and run by either adapter's {@link Database}.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";

import type { NormalisedEmail } from "../accounts/email.js";
import { type Database, runBatch } from "./database.js";
import type { InviteRepo } from "./repositories.js";
import { gamePlayers, games, invites, pastOpponents, users } from "./schema.js";

/** No row of game `gameId` holds user `userId` (SQL operands): the "no other row" guard. */
function holdsNoRow(gameId: unknown, userId: unknown) {
  return sql`NOT EXISTS (SELECT 1 FROM ${gamePlayers} AS other_row WHERE other_row.game_id = ${gameId} AND other_row.user_id = ${userId})`;
}

/**
 * An email-invite seat that may be claimed (06 §6.4): `invited`, no user yet, never `inert`, in a
 * lobby not yet due to expire. Columns of `game_players` and `games`, so it serves both queries.
 */
function claimableSeat(createdAfter: number) {
  return and(
    eq(gamePlayers.state, "invited"),
    isNull(gamePlayers.userId),
    ne(gamePlayers.delivery, "inert"),
    isNotNull(gamePlayers.inviteEmail),
    eq(games.status, "lobby"),
    gt(games.createdAt, createdAfter),
  );
}

export function inviteRepo(db: Database): InviteRepo {
  return {
    async receivedSince(creatorId, since, targets) {
      const statements = targets.map((target) =>
        db
          .select({
            fromCreator: sql<number>`coalesce(sum(CASE WHEN ${invites.inviterId} = ${creatorId} THEN 1 ELSE 0 END), 0)`,
            total: sql<number>`coalesce(sum(CASE WHEN ${gamePlayers.id} IS NULL OR ${gamePlayers.delivery} = 'normal' THEN 1 ELSE 0 END), 0)`,
          })
          .from(invites)
          .innerJoin(games, eq(games.id, invites.gameId))
          .leftJoin(gamePlayers, eq(gamePlayers.id, invites.id))
          .where(
            and(
              eq(invites.emailHash, target.emailHash),
              gt(games.createdAt, since),
              sql`${invites.inviterId} NOT IN (SELECT ${pastOpponents.otherId} FROM ${pastOpponents} WHERE ${pastOpponents.userId} = ${target.userId})`,
              sql`(${gamePlayers.id} IS NULL OR ${gamePlayers.delivery} <> 'inert')`,
              sql`(${gamePlayers.state} = 'declined' OR (coalesce(${gamePlayers.state}, '') <> 'removed' AND ${games.status} NOT IN ('cancelled', 'expired', 'declined')))`,
            ),
          ),
      );
      const results = (await runBatch(db, statements)) as {
        fromCreator: number | null;
        total: number | null;
      }[][];
      return targets.map((_target, i) => {
        const [row] = results[i] ?? [];
        return { fromCreator: row?.fromCreator ?? 0, total: row?.total ?? 0 };
      });
    },
    async claimable(email, createdAfter, limit) {
      return db
        .select({ playerId: gamePlayers.id, gameId: gamePlayers.gameId })
        .from(gamePlayers)
        .innerJoin(games, eq(games.id, gamePlayers.gameId))
        .where(and(eq(gamePlayers.inviteEmail, email), claimableSeat(createdAfter)))
        .orderBy(asc(games.createdAt), asc(gamePlayers.id))
        .limit(limit);
    },
    async pending(createdAfter, limit) {
      const rows = await db
        .select({
          playerId: gamePlayers.id,
          gameId: gamePlayers.gameId,
          userId: users.id,
          email: users.email,
        })
        .from(gamePlayers)
        .innerJoin(games, eq(games.id, gamePlayers.gameId))
        .innerJoin(users, eq(users.email, gamePlayers.inviteEmail))
        .where(
          and(
            claimableSeat(createdAfter),
            eq(users.kind, "human"),
            isNotNull(users.onboardedAt),
            isNull(users.suspendedAt),
            isNull(users.deletionRequestedAt),
            holdsNoRow(gamePlayers.gameId, users.id),
          ),
        )
        .orderBy(asc(games.createdAt), asc(gamePlayers.id))
        .limit(limit);
      // The join on the address makes it non-null; the check keeps the type honest.
      return rows.flatMap((row) =>
        row.email === null ? [] : [{ ...row, email: row.email as NormalisedEmail }],
      );
    },
    async claim(claim) {
      // Every guard of 02 §4 in the one statement that claims: a concurrent start, remove,
      // accept, cancel, expiry or another claim makes it match nothing.
      const rows = await db
        .update(gamePlayers)
        .set({ userId: claim.userId, ...(claim.inert ? { delivery: "inert" as const } : {}) })
        .where(
          and(
            eq(gamePlayers.id, claim.playerId),
            eq(gamePlayers.gameId, claim.gameId),
            eq(gamePlayers.state, "invited"),
            isNull(gamePlayers.userId),
            ne(gamePlayers.delivery, "inert"),
            eq(gamePlayers.inviteEmail, claim.email),
            holdsNoRow(claim.gameId, claim.userId),
            sql`EXISTS (SELECT 1 FROM ${games} WHERE ${games.id} = ${claim.gameId} AND ${games.status} = 'lobby' AND ${games.version} = ${claim.expectedVersion})`,
          ),
        )
        .returning({ id: gamePlayers.id });
      return rows.length === 1;
    },
    async markSent(inviteIds, at) {
      if (inviteIds.length === 0) return;
      await db
        .update(invites)
        .set({ sentAt: at })
        .where(inArray(invites.id, [...inviteIds]));
    },
  };
}
