/**
 * The push subscription repository (docs/spec/04-data-model.md `push_subscriptions`, alpha A8).
 * Written once over the shared schema and run by either adapter's {@link Database}. A
 * subscription dies with its session through the foreign key (06 §4).
 */
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import { type Database, runBatch } from "./database.js";
import type { PushSubscriptionRepo } from "./repositories.js";
import { pushSubscriptions } from "./schema.js";

export function pushSubscriptionRepo(db: Database): PushSubscriptionRepo {
  return {
    async save(subscription, maxPerUser) {
      const sameUser = sql`${pushSubscriptions.userId} = excluded.user_id`;
      const upsert = db
        .insert(pushSubscriptions)
        .values(subscription)
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            userId: sql`excluded.user_id`,
            sessionId: sql`excluded.session_id`,
            p256dh: sql`excluded.p256dh`,
            auth: sql`excluded.auth`,
            // A device changing hands is a new subscription for its new user.
            createdAt: sql`CASE WHEN ${sameUser} THEN ${pushSubscriptions.createdAt} ELSE excluded.created_at END`,
            lastSuccessAt: sql`CASE WHEN ${sameUser} THEN ${pushSubscriptions.lastSuccessAt} ELSE NULL END`,
          },
        });
      // The user's newest `maxPerUser`, the one just saved first whatever its age.
      const kept = db
        .select({ id: pushSubscriptions.id })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, subscription.userId))
        .orderBy(
          sql`${pushSubscriptions.endpoint} = ${subscription.endpoint} DESC`,
          sql`${pushSubscriptions.createdAt} DESC`,
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
    async forUsers(userIds) {
      if (userIds.length === 0) return [];
      return db
        .select()
        .from(pushSubscriptions)
        .where(inArray(pushSubscriptions.userId, [...userIds]));
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
