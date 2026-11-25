/**
 * The sign-in repositories (docs/spec/06-auth.md §3–§4): OTP challenges, sessions, rate limits,
 * auth events, account deletion and API-token revocation. Written once over the shared schema and
 * run by either adapter's {@link Database}; every multi-statement write is one atomic batch.
 */
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { type Database, runBatch } from "./database.js";
import { guardedInsert } from "./queries/transition.js";
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
      await db
        .update(users)
        .set({
          settings: sql`json_set(${SETTINGS_OBJECT}, '$.emailNudges', json(${change.enabled ? "true" : "false"}))`,
          updatedAt: change.updatedAt,
          ...(change.emailId === null ? {} : { emailId: change.emailId }),
        })
        .where(eq(users.id, id));
    },
    async disableNudgesByEmailId(emailId, updatedAt) {
      await db
        .update(users)
        .set({
          settings: sql`json_set(${SETTINGS_OBJECT}, '$.emailNudges', json('false'))`,
          updatedAt,
        })
        .where(and(eq(users.emailId, emailId), NUDGES_ON));
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
