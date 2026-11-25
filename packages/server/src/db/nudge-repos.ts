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

export function nudgeRepo(db: Database): NudgeRepo {
  return {
    async due(window, limit) {
      const rows = await db
        .select({
          playerId: gamePlayers.id,
          gameId: games.id,
          gameType: games.gameType,
          gameVersion: games.gameVersion,
          seat: gamePlayers.seat,
          userId: users.id,
          email: users.email,
          emailId: users.emailId,
        })
        .from(gamePlayers)
        .innerJoin(games, eq(games.id, gamePlayers.gameId))
        .innerJoin(users, eq(users.id, gamePlayers.userId))
        .where(
          and(
            seatDue(window),
            eq(games.status, "active"),
            eq(users.kind, "human"),
            isNotNull(users.email),
            isNotNull(users.emailId),
            isNotNull(users.onboardedAt),
            isNull(users.suspendedAt),
            isNull(users.deletionRequestedAt),
            NUDGES_ON,
            sql`NOT EXISTS (SELECT 1 FROM ${emailSuppressions} WHERE ${emailSuppressions.emailHash} = ${users.emailId})`,
          ),
        )
        .orderBy(asc(gamePlayers.toActSince), asc(gamePlayers.id))
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
      const rows = await db
        .update(gamePlayers)
        .set({ lastNudgedAt: now })
        .where(and(eq(gamePlayers.id, playerId), seatDue(window)))
        .returning({ id: gamePlayers.id });
      return rows.length === 1;
    },
  };
}

export function emailSuppressionRepo(db: Database): EmailSuppressionRepo {
  return {
    async suppress(emailHash, reason, createdAt) {
      await db
        .insert(emailSuppressions)
        .values({ emailHash, reason, createdAt })
        .onConflictDoNothing({ target: emailSuppressions.emailHash });
    },
  };
}
