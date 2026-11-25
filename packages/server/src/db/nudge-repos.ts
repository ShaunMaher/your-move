/**
 * The email-nudge repositories (docs/spec/03-architecture.md §7, alpha A6): which seats are due an
 * "It's your turn" email, the claim of one nudge, and the suppression list. Written once over the
 * shared schema and run by either adapter's {@link Database}.
 */
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import type { NormalisedEmail } from "../accounts/email.js";
import { NUDGES_ON } from "./auth-repos.js";
import type { Database } from "./database.js";
import type { EmailSuppressionRepo, NudgeRepo, NudgeWindow } from "./repositories.js";
import { emailSuppressions, gamePlayers, games, users } from "./schema.js";

/** The seat is in `toAct`, idle since the window's cut-off and not nudged within it. */
function seatDue(window: NudgeWindow) {
  return and(
    eq(gamePlayers.state, "playing"),
    eq(gamePlayers.toAct, 1),
    isNotNull(gamePlayers.toActSince),
    lte(gamePlayers.toActSince, window.idleSince),
    or(isNull(gamePlayers.lastNudgedAt), lte(gamePlayers.lastNudgedAt, window.nudgedBefore)),
  );
}

/**
 * The user may be nudged (03 §7): an onboarded human, not suspended or being deleted, with nudges
 * on and an `email_id` that hasn't bounced or complained. An `unsubscribed` suppression doesn't
 * stop nudges: it is written only for invite emails, and nudges have their own opt-out (the
 * setting and `email_id`). Columns of `users` only, so it serves both the join in `due` and the
 * subquery in `claim`.
 */
const USER_ELIGIBLE = and(
  eq(users.kind, "human"),
  isNotNull(users.email),
  isNotNull(users.emailId),
  isNotNull(users.onboardedAt),
  isNull(users.suspendedAt),
  isNull(users.deletionRequestedAt),
  NUDGES_ON,
  sql`NOT EXISTS (SELECT 1 FROM ${emailSuppressions} WHERE ${emailSuppressions.emailHash} = ${users.emailId} AND ${emailSuppressions.reason} IN ('bounced', 'complained'))`,
);

export function nudgeRepo(db: Database): NudgeRepo {
  return {
    async due(window, limit, installed) {
      if (installed.length === 0) return [];
      const seatNudged = sql`coalesce(${gamePlayers.lastNudgedAt}, 0)`;
      // Every due seat, numbered within its recipient (their least recently nudged seat first),
      // and with when that recipient was last nudged in any game. Each column is named, since
      // the outer query reads them by name and several tables have an `id`.
      const candidates = db
        .select({
          playerId: sql<string>`${gamePlayers.id}`.as("player_id"),
          gameId: sql<string>`${games.id}`.as("game_id"),
          gameType: sql<string>`${games.gameType}`.as("game_type"),
          gameVersion: sql<number>`${games.gameVersion}`.as("game_version"),
          seat: sql<number | null>`${gamePlayers.seat}`.as("seat"),
          userId: sql<string>`${users.id}`.as("user_id"),
          email: sql<string | null>`${users.email}`.as("email"),
          emailId: sql<string | null>`${users.emailId}`.as("email_id"),
          toActSince: sql<number>`${gamePlayers.toActSince}`.as("to_act_since"),
          seatNudged: sql<number>`${seatNudged}`.as("seat_nudged"),
          recipientNudged:
            sql<number>`(SELECT coalesce(max(recipient_seats.last_nudged_at), 0) FROM ${gamePlayers} AS recipient_seats WHERE recipient_seats.user_id = ${users.id})`.as(
              "recipient_nudged",
            ),
          place:
            sql<number>`row_number() OVER (PARTITION BY ${users.id} ORDER BY ${seatNudged}, ${gamePlayers.toActSince}, ${gamePlayers.id})`.as(
              "place",
            ),
        })
        .from(gamePlayers)
        .innerJoin(games, eq(games.id, gamePlayers.gameId))
        .innerJoin(users, eq(users.id, gamePlayers.userId))
        .where(
          and(
            seatDue(window),
            eq(games.status, "active"),
            // Orphaned games never take a place in the queue (02 §7.3).
            or(
              ...installed.map((pair) =>
                and(eq(games.gameType, pair.gameType), eq(games.gameVersion, pair.gameVersion)),
              ),
            ),
            USER_ELIGIBLE,
          ),
        )
        .as("candidates");
      // One seat per recipient per page, the least recently nudged recipients first, so neither
      // one recipient's many games nor a recipient held back by their own daily cap can keep
      // everyone else waiting (A6-S2-2, P3-1).
      const rows = await db
        .select({
          playerId: candidates.playerId,
          gameId: candidates.gameId,
          gameType: candidates.gameType,
          gameVersion: candidates.gameVersion,
          seat: candidates.seat,
          userId: candidates.userId,
          email: candidates.email,
          emailId: candidates.emailId,
        })
        .from(candidates)
        .where(eq(candidates.place, 1))
        .orderBy(
          asc(candidates.recipientNudged),
          asc(candidates.seatNudged),
          asc(candidates.toActSince),
          asc(candidates.playerId),
        )
        .limit(limit);
      // The filters above make these non-null; the checks keep the types honest.
      return rows.flatMap((row) =>
        row.seat === null || row.email === null || row.emailId === null
          ? []
          : [
              {
                ...row,
                seat: row.seat,
                email: row.email as NormalisedEmail,
                emailId: row.emailId,
              },
            ],
      );
    },
    async claim(playerId, now, window) {
      // Everything due() checked, again, in the one statement that claims (A6-S-3).
      const rows = await db
        .update(gamePlayers)
        .set({ lastNudgedAt: now })
        .where(
          and(
            eq(gamePlayers.id, playerId),
            seatDue(window),
            sql`EXISTS (SELECT 1 FROM ${games} WHERE ${games.id} = ${gamePlayers.gameId} AND ${games.status} = 'active')`,
            sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${gamePlayers.userId} AND ${USER_ELIGIBLE})`,
          ),
        )
        .returning({ id: gamePlayers.id });
      return rows.length === 1;
    },
  };
}

export function emailSuppressionRepo(db: Database): EmailSuppressionRepo {
  return {
    async suppress(emailHash, reason, createdAt) {
      // A bounce or complaint replaces an unsubscribe (it stops more mail, 04), never the
      // reverse; created_at says when the row's current reason was recorded.
      await db
        .insert(emailSuppressions)
        .values({ emailHash, reason, createdAt })
        .onConflictDoUpdate({
          target: emailSuppressions.emailHash,
          set: { reason: sql`excluded.reason`, createdAt: sql`excluded.created_at` },
          setWhere: sql`${emailSuppressions.reason} = 'unsubscribed' AND excluded.reason IN ('bounced', 'complained')`,
        });
    },
  };
}
