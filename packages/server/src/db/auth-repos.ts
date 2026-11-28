/**
 * The sign-in repositories (docs/spec/06-auth.md §3–§4): OTP challenges, sessions, rate limits,
 * auth events, account deletion and API-token revocation. Written once over the shared schema and
 * run by either adapter's {@link Database}; every multi-statement write is one atomic batch.
 */
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import type { NormalisedEmail } from "../accounts/email.js";
import { type Database, runBatch, runBatchEndingWith, type Statement } from "./database.js";
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
    async saveOnboarding(id, set, complete) {
      // `set` always has `updatedAt`: anything more is a column to write.
      const write =
        Object.keys(set).length > 1 ? [db.update(users).set(set).where(eq(users.id, id))] : [];
      // Judged on the stored row inside the batch, after this request's own write: two requests
      // that each bring one answer still complete onboarding, whichever commits second.
      const completed = await runBatchEndingWith(
        db,
        write,
        db
          .update(users)
          .set({ onboardedAt: complete.at, updatedAt: complete.at })
          .where(
            and(
              eq(users.id, id),
              isNull(users.onboardedAt),
              isNotNull(users.displayName),
              gte(users.ageAttestedMinAge, complete.minAge),
            ),
          )
          .returning(),
      );
      const row = completed[0];
      if (row !== undefined) return { completed: true, user: asUser(row) };
      return {
        completed: false,
        user: asUser(await db.select().from(users).where(eq(users.id, id)).get()),
      };
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
    async canBlock(viewerId, otherId) {
      if (viewerId === otherId) return false;
      const mine = alias(gamePlayers, "mine");
      const theirs = alias(gamePlayers, "theirs");
      const row = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, otherId),
            eq(users.kind, "human"),
            or(
              // Already blocked: a repeat is the same answer (05 §Blocks).
              exists(
                db
                  .select({ one: sql`1` })
                  .from(blocks)
                  .where(and(eq(blocks.blockerId, viewerId), eq(blocks.blockedId, otherId))),
              ),
              exists(
                db
                  .select({ one: sql`1` })
                  .from(pastOpponents)
                  .where(
                    and(eq(pastOpponents.userId, viewerId), eq(pastOpponents.otherId, otherId)),
                  ),
              ),
              // A shared game, through a row the viewer can attribute (A23-S-1): joined (the
              // creator's included), or the viewer's own open pick. Never a typed address's row,
              // open or not, which would tie the address to the account (Q3); and only where the
              // viewer's own row was visible to them.
              exists(
                db
                  .select({ one: sql`1` })
                  .from(mine)
                  .innerJoin(theirs, eq(theirs.gameId, mine.gameId))
                  .where(
                    and(
                      eq(mine.userId, viewerId),
                      eq(theirs.userId, otherId),
                      or(ne(mine.delivery, "inert"), isNotNull(mine.joinedAt)),
                      or(
                        isNotNull(theirs.joinedAt),
                        and(
                          eq(mine.joinedVia, "creator"),
                          eq(theirs.state, "invited"),
                          isNull(theirs.inviteEmail),
                        ),
                      ),
                    ),
                  ),
              ),
            ),
          ),
        )
        .get();
      return row !== undefined;
    },
    async block(blockerId, blockedId, createdAt) {
      const blockerRows = alias(gamePlayers, "blocker_rows");
      await runBatch(db, [
        db.insert(blocks).values({ blockerId, blockedId, createdAt }).onConflictDoNothing(),
        // Never a past-opponent pair with a block either way (04 invariant 6).
        db
          .delete(pastOpponents)
          .where(
            or(
              and(eq(pastOpponents.userId, blockerId), eq(pastOpponents.otherId, blockedId)),
              and(eq(pastOpponents.userId, blockedId), eq(pastOpponents.otherId, blockerId)),
            ),
          ),
        // The blocked person's open invitations in the blocker's lobbies go quiet (A23-S-2):
        // `inert`, as at creation, so to them each is gone as if removed, while everyone else sees
        // it as before. A row-level update like a claim: no version moves.
        db
          .update(gamePlayers)
          .set({ delivery: "inert" })
          .where(
            and(
              eq(gamePlayers.userId, blockedId),
              eq(gamePlayers.state, "invited"),
              inArray(gamePlayers.delivery, ["normal", "hidden"]),
              inArray(
                gamePlayers.gameId,
                db
                  .select({ id: blockerRows.gameId })
                  .from(blockerRows)
                  .innerJoin(games, eq(games.id, blockerRows.gameId))
                  .where(
                    and(
                      eq(blockerRows.userId, blockerId),
                      eq(games.status, "lobby"),
                      or(
                        eq(blockerRows.state, "joined"),
                        and(
                          eq(blockerRows.state, "invited"),
                          inArray(blockerRows.delivery, ["normal", "hidden"]),
                        ),
                      ),
                    ),
                  ),
              ),
            ),
          ),
      ]);
    },
    async unblock(blockerId, blockedId) {
      const removed = await db
        .delete(blocks)
        .where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)))
        .returning({ id: blocks.blockedId });
      return removed.length > 0;
    },
    async blocksOf(blockerId, page) {
      const { after } = page;
      return db
        .select({
          userId: blocks.blockedId,
          displayName: users.displayName,
          createdAt: blocks.createdAt,
        })
        .from(blocks)
        .innerJoin(users, eq(users.id, blocks.blockedId))
        .where(
          and(
            eq(blocks.blockerId, blockerId),
            after === undefined
              ? undefined
              : or(
                  lt(blocks.createdAt, after.createdAt),
                  and(eq(blocks.createdAt, after.createdAt), lt(blocks.blockedId, after.userId)),
                ),
          ),
        )
        .orderBy(desc(blocks.createdAt), desc(blocks.blockedId))
        .limit(page.limit);
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
      const exists = sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${user.id})`;
      await runBatch(db, [
        ...shortDeletion(db, user),
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
        guardedInsert(db, authEvents, { id: crypto.randomUUID(), ...event }, exists),
        db.delete(users).where(eq(users.id, user.id)),
      ]);
    },
    async underAgeDelete(account, at) {
      // Every statement is guarded on the account still not being onboarded (06 §5), read inside
      // the batch, so an onboarding that won the race leaves this batch writing nothing at all.
      const pending = sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${account.id} AND ${users.onboardedAt} IS NULL)`;
      const event = (type: "under_age_exit" | "account_deleted") =>
        guardedInsert(
          db,
          authEvents,
          {
            id: crypto.randomUUID(),
            userId: account.id,
            type,
            ipHash: at.ipHash,
            createdAt: at.createdAt,
          },
          pending,
        );
      const deleted = await runBatchEndingWith(
        db,
        [
          ...shortDeletion(db, account, pending),
          // No more invite emails to the address (04 `email_suppressions`); a row already there
          // keeps its reason, which stops at least as much mail.
          guardedInsert(
            db,
            emailSuppressions,
            { emailHash: account.emailId, reason: "unsubscribed", createdAt: at.createdAt },
            pending,
          ).onConflictDoNothing({ target: emailSuppressions.emailHash }),
          // Its pending email seats are never delivered or claimed (04 `delivery`). Not a game
          // transition: like a claim, the row changes in a way no member can see (the creator
          // still sees the typed address while the seat is invited, Q3), so the version stays.
          db
            .update(gamePlayers)
            .set({ delivery: "inert" })
            .where(
              and(
                eq(gamePlayers.state, "invited"),
                isNull(gamePlayers.userId),
                eq(gamePlayers.inviteEmail, account.email),
                pending,
              ),
            ),
          event("under_age_exit"),
          event("account_deleted"),
        ],
        db
          .delete(users)
          .where(and(eq(users.id, account.id), isNull(users.onboardedAt)))
          .returning({ id: users.id }),
      );
      return deleted.length === 1;
    },
  };
}

/**
 * The account-deletion statements every deletion shares (04 §Account deletion steps 1 and 3):
 * sessions and API tokens first, so the account is unusable from the first statement (its agents
 * go with the users row, whose `owner_user_id` cascades, and their sessions and tokens with them),
 * then OTP challenges, blocks and past-opponent rows. With a `guard`, each applies only while it
 * holds, read inside the batch.
 */
function shortDeletion(
  db: Database,
  user: { readonly id: string; readonly email: NormalisedEmail },
  guard?: SQL,
): Statement[] {
  const when = (condition: SQL | undefined) =>
    guard === undefined ? condition : and(condition, guard);
  return [
    db.delete(sessions).where(when(eq(sessions.userId, user.id))),
    db
      .delete(apiTokens)
      .where(when(or(eq(apiTokens.userId, user.id), eq(apiTokens.createdBy, user.id)))),
    db.delete(otpChallenges).where(when(eq(otpChallenges.email, user.email))),
    db.delete(blocks).where(when(or(eq(blocks.blockerId, user.id), eq(blocks.blockedId, user.id)))),
    db
      .delete(pastOpponents)
      .where(when(or(eq(pastOpponents.userId, user.id), eq(pastOpponents.otherId, user.id)))),
  ];
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
