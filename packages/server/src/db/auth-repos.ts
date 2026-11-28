/**
 * The sign-in repositories (docs/spec/06-auth.md §3–§4): OTP challenges, sessions, rate limits,
 * auth events, account deletion and API-token revocation. Written once over the shared schema and
 * run by either adapter's {@link Database}; every multi-statement write is one atomic batch.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import { type Database, runBatch } from "./database.js";
import { guardedInsert, unblocked } from "./queries/transition.js";
import type {
  ApiTokenRepo,
  AuthEventRepo,
  OtpRepo,
  RateLimitCount,
  RateLimitRepo,
  SessionRepo,
  UserRecord,
  UserRepo,
} from "./repositories.js";
import {
  apiTokens,
  authEvents,
  blocks,
  emailSuppressions,
  gamePlayers,
  games,
  joinLinks,
  otpChallenges,
  pastOpponents,
  rateLimits,
  sessions,
  users,
} from "./schema.js";

/**
 * A stored row as a {@link UserRecord}: addresses are written only as `NormalisedEmail` (the
 * repository takes nothing else), so a stored one carries the brand.
 */
function asUser(row: typeof users.$inferSelect | undefined): UserRecord | null {
  return (row as UserRecord | undefined) ?? null;
}

/** `users.settings` as a JSON object: settings that aren't one count as empty. */
const SETTINGS_OBJECT = sql`(CASE WHEN json_valid(${users.settings}) AND json_type(${users.settings}) = 'object' THEN ${users.settings} ELSE '{}' END)`;

/** The user has email nudges on: `settings.emailNudges` is JSON `true`, nothing else (03 §7). */
export const NUDGES_ON = sql`json_type(${SETTINGS_OBJECT}, '$.emailNudges') = 'true'`;

/**
 * A past-opponent row (of `past_opponents.user_id`) whose other user may be picked for a game
 * (06 §6.1, alpha A12): an onboarded human, neither suspended nor being deleted, with no block
 * between the two in either direction. A blocked pair has no row anyway (04 invariant 6); the
 * block is checked explicitly rather than relying on that (06 §6.1).
 */
const PICKABLE = and(
  eq(users.kind, "human"),
  isNotNull(users.onboardedAt),
  isNotNull(users.displayName),
  isNull(users.suspendedAt),
  isNull(users.deletionRequestedAt),
  sql`NOT EXISTS (SELECT 1 FROM ${blocks} WHERE (${blocks.blockerId} = ${pastOpponents.userId} AND ${blocks.blockedId} = ${pastOpponents.otherId}) OR (${blocks.blockerId} = ${pastOpponents.otherId} AND ${blocks.blockedId} = ${pastOpponents.userId}))`,
);

export function userRepo(db: Database): UserRepo {
  return {
    async create(user) {
      await db.insert(users).values(user);
    },
    async createOrGetByEmail(user) {
      const [, found] = await runBatch(db, [
        db.insert(users).values(user).onConflictDoNothing({ target: users.email }),
        db.select().from(users).where(eq(users.email, user.email)),
      ]);
      const row = (found as UserRecord[])[0];
      if (row === undefined) throw new Error("users.createOrGetByEmail: no row after insert");
      return row;
    },
    async findById(id) {
      return asUser(await db.select().from(users).where(eq(users.id, id)).get());
    },
    async findByIds(ids) {
      if (ids.length === 0) return [];
      const rows = await db
        .select()
        .from(users)
        .where(inArray(users.id, [...ids]));
      return rows as UserRecord[];
    },
    async findByEmail(email) {
      return asUser(await db.select().from(users).where(eq(users.email, email)).get());
    },
    async update(id, set) {
      await db.update(users).set(set).where(eq(users.id, id));
    },
    async pastOpponentsOf(userId, candidates) {
      if (candidates.length === 0) return [];
      const rows = await db
        .select({ otherId: pastOpponents.otherId })
        .from(pastOpponents)
        .where(
          and(eq(pastOpponents.userId, userId), inArray(pastOpponents.otherId, [...candidates])),
        );
      return rows.map((row) => row.otherId);
    },
    async pickableOpponents(userId, candidates) {
      if (candidates.length === 0) return [];
      const rows = await db
        .select({ otherId: pastOpponents.otherId })
        .from(pastOpponents)
        .innerJoin(users, eq(users.id, pastOpponents.otherId))
        .where(
          and(
            eq(pastOpponents.userId, userId),
            inArray(pastOpponents.otherId, [...candidates]),
            PICKABLE,
          ),
        );
      return rows.map((row) => row.otherId);
    },
    async recentOpponents(userId, limit) {
      const rows = await db
        .select({
          userId: pastOpponents.otherId,
          displayName: users.displayName,
          lastPlayedAt: pastOpponents.lastFinishedAt,
        })
        .from(pastOpponents)
        .innerJoin(users, eq(users.id, pastOpponents.otherId))
        .where(and(eq(pastOpponents.userId, userId), PICKABLE))
        .orderBy(desc(pastOpponents.lastFinishedAt), asc(pastOpponents.otherId))
        .limit(limit);
      // PICKABLE keeps only rows with a display name.
      return rows.map((row) => ({ ...row, displayName: row.displayName ?? "" }));
    },
    async blocksAmong(userIds) {
      if (userIds.length === 0) return [];
      const ids = [...userIds];
      return db
        .select({ blockerId: blocks.blockerId, blockedId: blocks.blockedId })
        .from(blocks)
        .where(and(inArray(blocks.blockerId, ids), inArray(blocks.blockedId, ids)));
    },
    async rememberGameOptions(id, remember) {
      // Only the two keys change, in SQL, so a concurrent change to any other setting survives
      // (A2 review S-3).
      const base = SETTINGS_OBJECT;
      const lastOptions = sql`(CASE WHEN json_type(${base}, '$.lastOptions') = 'object' THEN json_extract(${base}, '$.lastOptions') ELSE '{}' END)`;
      const type = remember.gameType;
      const settings =
        remember.input === null
          ? sql`json_set(${base}, '$.lastGameType', ${type})`
          : sql`json_set(${base}, '$.lastOptions', json_set(${lastOptions}, ${`$."${type}"`}, json(${remember.input})), '$.lastGameType', ${type})`;
      await db
        .update(users)
        .set({ settings, updatedAt: remember.updatedAt })
        .where(eq(users.id, id));
    },
    async setEmailNudges(id, change) {
      // One key, in SQL, like rememberGameOptions: other settings survive a concurrent change.
      const set = db
        .update(users)
        .set({
          settings: sql`json_set(${SETTINGS_OBJECT}, '$.emailNudges', json(${change.enabled ? "true" : "false"}))`,
          emailId: change.enabled ? change.emailId : null,
          updatedAt: change.updatedAt,
        })
        .where(eq(users.id, id));
      if (!change.enabled) {
        await set;
        return;
      }
      // Turning them on is the address holder's own opt-in: it lifts their own `unsubscribed` row,
      // never a `bounced` or `complained` one (04, alpha A20 review P-3). One batch.
      await runBatch(db, [
        set,
        db
          .delete(emailSuppressions)
          .where(
            and(
              eq(emailSuppressions.emailHash, change.emailId),
              eq(emailSuppressions.reason, "unsubscribed"),
            ),
          ),
      ]);
    },
    async setTheme(id, theme, updatedAt) {
      // One key, in SQL, like setEmailNudges. The value is one of three fixed words, bound as text.
      await db
        .update(users)
        .set({ settings: sql`json_set(${SETTINGS_OBJECT}, '$.theme', ${theme})`, updatedAt })
        .where(eq(users.id, id));
    },
    async disableNudgesByEmailId(emailId, updatedAt) {
      await db
        .update(users)
        .set({
          settings: sql`json_set(${SETTINGS_OBJECT}, '$.emailNudges', json('false'))`,
          emailId: null,
          updatedAt,
        })
        .where(eq(users.emailId, emailId));
    },
    async addPastOpponents(a, b, lastFinishedAt) {
      // Both accounts are humans that still exist, neither suspended nor being deleted (04
      // §Account deletion removes its pairs and must not see one come back; agents never have
      // pairs, 04 invariant 7), and no block either way (04 invariant 6), checked in the
      // statements that write, so a block or suspension written meanwhile is never crossed.
      const live = (id: string) =>
        sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${id} AND ${users.kind} = 'human' AND ${users.suspendedAt} IS NULL AND ${users.deletionRequestedAt} IS NULL)`;
      const guard = sql`${live(a)} AND ${live(b)} AND ${unblocked(a, b)}`;
      const pair = (userId: string, otherId: string) =>
        guardedInsert(
          db,
          pastOpponents,
          { userId, otherId, lastFinishedAt },
          guard,
        ).onConflictDoUpdate({
          target: [pastOpponents.userId, pastOpponents.otherId],
          // A pair that exists keeps the later of its time and this one (05 `add-player`).
          set: {
            lastFinishedAt: sql`max(${pastOpponents.lastFinishedAt}, excluded.last_finished_at)`,
          },
        });
      await runBatch(db, [pair(a, b), pair(b, a)]);
    },
    async hasPastOpponent(userId) {
      const row = await db
        .select({ otherId: pastOpponents.otherId })
        .from(pastOpponents)
        .where(eq(pastOpponents.userId, userId))
        .limit(1)
        .get();
      return row !== undefined;
    },
    async deleteAccount(user, event) {
      // Agents go with their owner (owner_user_id cascades), and their sessions and tokens with
      // them; the user's own sessions and tokens cascade from the users row too, but are deleted
      // first so the account is unusable from the first statement (04 §Account deletion).
      await runBatch(db, [
        db.delete(sessions).where(eq(sessions.userId, user.id)),
        db
          .delete(apiTokens)
          .where(or(eq(apiTokens.userId, user.id), eq(apiTokens.createdBy, user.id))),
        db.delete(otpChallenges).where(eq(otpChallenges.email, user.email)),
        db.delete(blocks).where(or(eq(blocks.blockerId, user.id), eq(blocks.blockedId, user.id))),
        db
          .delete(pastOpponents)
          .where(or(eq(pastOpponents.userId, user.id), eq(pastOpponents.otherId, user.id))),
        // The links of the lobbies the user created (alpha A18): before the users row goes, while
        // the creator row still names the user. Cancelling those lobbies is step 2's (04, M4).
        db.delete(joinLinks).where(
          inArray(
            joinLinks.gameId,
            db
              .select({ gameId: gamePlayers.gameId })
              .from(gamePlayers)
              .innerJoin(games, eq(games.id, gamePlayers.gameId))
              .where(
                and(
                  eq(gamePlayers.userId, user.id),
                  eq(gamePlayers.joinedVia, "creator"),
                  eq(games.status, "lobby"),
                ),
              ),
          ),
        ),
        guardedInsert(
          db,
          authEvents,
          { id: crypto.randomUUID(), ...event },
          sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${user.id})`,
        ),
        db.delete(users).where(eq(users.id, user.id)),
      ]);
    },
  };
}

/** Whether a challenge is live: unconsumed, unexpired, with attempts left (06 §3). */
function liveChallenge(now: number, maxAttempts: number) {
  return and(
    isNull(otpChallenges.consumedAt),
    gt(otpChallenges.expiresAt, now),
    lt(otpChallenges.attempts, maxAttempts),
  );
}

/** Newest first; `rowid` orders challenges issued in the same millisecond by insertion. */
const NEWEST_FIRST = [desc(otpChallenges.createdAt), sql`rowid DESC`] as const;

export function otpRepo(db: Database): OtpRepo {
  return {
    async issue(challenge, { create, maxLive, maxAttempts }) {
      const now = challenge.createdAt;
      const enabled = sql`${create ? 1 : 0}`;
      // A never-emailed challenge (06 §3.2) burns nothing: the statement still runs, matching no row.
      const burns = create && challenge.emailed === 1 ? 1 : 0;
      const beyondNewest = db
        .select({ id: otpChallenges.id })
        .from(otpChallenges)
        .where(
          and(
            eq(otpChallenges.email, challenge.email),
            eq(otpChallenges.purpose, challenge.purpose),
            liveChallenge(now, maxAttempts),
            // Only emailed challenges hold or lose a place among the newest: a never-emailed one
            // can't verify, so it must not push a real code out.
            eq(otpChallenges.emailed, 1),
          ),
        )
        .orderBy(...NEWEST_FIRST)
        // Drizzle emits no LIMIT for -1, and SQLite needs one before OFFSET.
        .limit(Number.MAX_SAFE_INTEGER)
        .offset(maxLive);
      await runBatch(db, [
        guardedInsert(db, otpChallenges, challenge, enabled),
        db
          .update(otpChallenges)
          .set({ consumedAt: now })
          // The flag is compared with each row (every selected row has emailed = 1), so SQLite
          // can't skip the subquery on a never-emailed path: the same work on every path.
          .where(and(inArray(otpChallenges.id, beyondNewest), eq(otpChallenges.emailed, burns))),
      ]);
    },
    async live(email, purpose, now, maxAttempts) {
      const rows = await db
        .select({ id: otpChallenges.id })
        .from(otpChallenges)
        .where(
          and(
            eq(otpChallenges.email, email),
            eq(otpChallenges.purpose, purpose),
            liveChallenge(now, maxAttempts),
          ),
        )
        .orderBy(...NEWEST_FIRST);
      return rows.map((row) => row.id);
    },
    async attempt(id, now, maxAttempts) {
      const rows = await db
        .update(otpChallenges)
        .set({ attempts: sql`${otpChallenges.attempts} + 1` })
        .where(and(eq(otpChallenges.id, id), liveChallenge(now, maxAttempts)))
        .returning({ codeHash: otpChallenges.codeHash, emailed: otpChallenges.emailed });
      const row = rows[0];
      return row === undefined ? null : { codeHash: row.codeHash, emailed: row.emailed === 1 };
    },
    async consume(id, now) {
      const rows = await db
        .update(otpChallenges)
        .set({ consumedAt: now })
        .where(and(eq(otpChallenges.id, id), isNull(otpChallenges.consumedAt)))
        .returning({ id: otpChallenges.id });
      return rows.length === 1;
    },
  };
}

export function sessionRepo(db: Database): SessionRepo {
  return {
    async create(session) {
      await db.insert(sessions).values(session);
    },
    async findByTokenHash(tokenHash) {
      const row = await db
        .select({ session: sessions, user: users })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.tokenHash, tokenHash))
        .get();
      return row === undefined ? null : { session: row.session, user: row.user as UserRecord };
    },
    async touch(id, lastSeenAt, expiresAt) {
      await db.update(sessions).set({ lastSeenAt, expiresAt }).where(eq(sessions.id, id));
    },
    async delete(userId, id) {
      await db.delete(sessions).where(and(eq(sessions.id, id), eq(sessions.userId, userId)));
    },
    async deleteAll(userId) {
      await db.delete(sessions).where(eq(sessions.userId, userId));
    },
  };
}

export function rateLimitRepo(db: Database): RateLimitRepo {
  return {
    async hit(hits) {
      const statements = hits.flatMap((hit) => [
        db
          .insert(rateLimits)
          .values({ key: hit.key, windowStart: hit.windowStart, count: hit.amount })
          .onConflictDoUpdate({
            target: [rateLimits.key, rateLimits.windowStart],
            set: { count: sql`${rateLimits.count} + ${hit.amount}` },
          })
          .returning({ count: rateLimits.count }),
        db
          .select({ count: rateLimits.count })
          .from(rateLimits)
          .where(
            and(eq(rateLimits.key, hit.key), eq(rateLimits.windowStart, hit.previousWindowStart)),
          ),
      ]);
      const results = (await runBatch(db, statements)) as { count: number }[][];
      const counts: RateLimitCount[] = [];
      for (let i = 0; i < hits.length; i++) {
        counts.push({
          current: results[2 * i]?.[0]?.count ?? 0,
          previous: results[2 * i + 1]?.[0]?.count ?? 0,
        });
      }
      return counts;
    },
  };
}

export function authEventRepo(db: Database): AuthEventRepo {
  return {
    async record(event) {
      await db.insert(authEvents).values({ id: crypto.randomUUID(), ...event });
    },
  };
}

export function apiTokenRepo(db: Database): ApiTokenRepo {
  return {
    async revokeAll(userId, now) {
      const agents = db.select({ id: users.id }).from(users).where(eq(users.ownerUserId, userId));
      await db
        .update(apiTokens)
        .set({ revokedAt: now })
        .where(
          and(
            isNull(apiTokens.revokedAt),
            or(eq(apiTokens.userId, userId), inArray(apiTokens.userId, agents)),
          ),
        );
    },
  };
}
