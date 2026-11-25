/**
 * The push subscription repository (docs/spec/04-data-model.md `push_subscriptions`, alpha A8).
 * Written once over the shared schema and run by either adapter's {@link Database}. A
 * subscription dies with its session through the foreign key (06 §4).
 */
import { and, eq, getTableColumns, gt, inArray, notInArray, sql } from "drizzle-orm";

import { type Database, runBatch } from "./database.js";
import type { PushSubscriptionRepo } from "./repositories.js";
import { pushSubscriptions, sessions } from "./schema.js";

export function pushSubscriptionRepo(db: Database): PushSubscriptionRepo {
  return {
    async save(subscription, { maxPerUser, live }) {
      const sameUser = sql`${pushSubscriptions.userId} = excluded.user_id`;
      const sameSession = sql`${pushSubscriptions.sessionId} = excluded.session_id`;
      const sameKeys = sql`${pushSubscriptions.p256dh} = excluded.p256dh
        AND ${pushSubscriptions.auth} = excluded.auth`;
      // The stored row's session is live (06 §4), by the session check's own cutoffs.
      const liveSession = sql`EXISTS (SELECT 1 FROM ${sessions}
        WHERE ${sessions.id} = ${pushSubscriptions.sessionId}
        AND ${sessions.expiresAt} > ${live.expiresAfter}
        AND ${sessions.createdAt} > ${live.createdAfter})`;
      const upsert = db
        .insert(pushSubscriptions)
        .values(subscription)
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          // Another user's or session's endpoint moves only with the same keys (the same browser
          // subscription, re-saved; A8-S-1) or once its session is no longer live, since that
          // row gets no pushes (A8-R2-2). Otherwise the row is left as it is.
          setWhere: sql`(${sameUser} AND ${sameSession}) OR (${sameKeys}) OR NOT ${liveSession}`,
          set: {
            userId: sql`excluded.user_id`,
            sessionId: sql`excluded.session_id`,
            p256dh: sql`excluded.p256dh`,
            auth: sql`excluded.auth`,
            // A device changing hands is a new subscription for its new user.
            createdAt: sql`CASE WHEN ${sameUser}
              THEN ${pushSubscriptions.createdAt} ELSE excluded.created_at END`,
            lastSuccessAt: sql`CASE WHEN ${sameUser}
              THEN ${pushSubscriptions.lastSuccessAt} ELSE NULL END`,
          },
        });
      // The user's `maxPerUser` most useful: the one just saved first whatever its age, then rows
      // of live sessions (the others get no pushes, so they go first, A8-R2-2), then by last
      // success, else creation.
      const kept = db
        .select({ id: pushSubscriptions.id })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, subscription.userId))
        .orderBy(
          sql`${pushSubscriptions.endpoint} = ${subscription.endpoint} DESC`,
          sql`${liveSession} DESC`,
          sql`coalesce(${pushSubscriptions.lastSuccessAt}, ${pushSubscriptions.createdAt}) DESC`,
          sql`${pushSubscriptions.id} DESC`,
        )
        .limit(maxPerUser);
      const evict = db
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.userId, subscription.userId),
            notInArray(pushSubscriptions.id, kept),
          ),
        );
      await runBatch(db, [upsert, evict]);
    },
    async remove(userId, endpoint) {
      await db
        .delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
    },
    async forUsers(userIds, live) {
      if (userIds.length === 0) return [];
      // Only subscriptions whose session is live: an expired session not yet deleted (that
      // happens lazily, at its next use) gets no more pushes (A8-S-2).
      return db
        .select(getTableColumns(pushSubscriptions))
        .from(pushSubscriptions)
        .innerJoin(sessions, eq(sessions.id, pushSubscriptions.sessionId))
        .where(
          and(
            inArray(pushSubscriptions.userId, [...userIds]),
            gt(sessions.expiresAt, live.expiresAfter),
            gt(sessions.createdAt, live.createdAfter),
          ),
        );
    },
    async delete(ids) {
      if (ids.length === 0) return;
      await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, [...ids]));
    },
    async delivered(ids, at) {
      if (ids.length === 0) return;
      await db
        .update(pushSubscriptions)
        .set({ lastSuccessAt: at })
        .where(inArray(pushSubscriptions.id, [...ids]));
    },
  };
}
