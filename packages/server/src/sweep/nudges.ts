/**
 * The sweep's "send due email nudges" step (docs/spec/03-architecture.md §7, §8; alpha A6): an
 * "It's your turn" email to each seat that has waited 24 h in `toAct`, at most once a day per game,
 * for users who turned nudges on. The room left under the instance-wide and per-recipient daily
 * caps (`LIMIT_NUDGE_EMAILS_PER_DAY`, `LIMIT_NUDGE_EMAILS_PER_USER_PER_DAY`, 08 §4) is read first,
 * a nudge is claimed (`last_nudged_at`) before it is sent, so two sweeps never both send one and a
 * failed send isn't retried that day (Q27), and only claimed nudges are counted. Each count is
 * checked too, so overlapping runs can't together pass the instance-wide cap (08 §4.2).
 *
 * The email carries only the game type's name, display names and the last public `describe` text
 * (08 T18): the game's state, options and scores are never read here.
 */
import { alertOncePerWindow, checkLimits } from "../auth/limits.js";
import type { Subkeys } from "../crypto/subkeys.js";
import type { DueNudge, NudgeWindow, Repositories } from "../db/repositories.js";
import { wasAlerted } from "../email/sender.js";
import { nudgeEmail } from "../email/templates.js";
import { unsubscribeToken, unsubscribeUrl } from "../email/unsubscribe-token.js";
import { namesBySeat, playerName, renderStoredText, seatedRows } from "../games/names.js";
import type { GameRegistry } from "../games/registry.js";
import type { Platform } from "../platform.js";

const HOUR = 60 * 60 * 1000;
/** How long a seat waits in `toAct` before it is nudged (03 §7). */
const NUDGE_IDLE_MS = 24 * HOUR;
/** At most one nudge per game per this long, for each seat (03 §7). */
const NUDGE_INTERVAL_MS = 24 * HOUR;

interface NudgeCounts {
  readonly sent: number;
  /**
   * Claimed, but not sent: building or sending the email failed, or (only when runs overlap) its
   * count went over the instance-wide cap. That day's nudge is lost.
   */
  readonly failed: number;
  /**
   * Not claimed: the recipient is at their daily cap, the seat moved on, the user stopped being
   * eligible, or another run took it.
   */
  readonly skipped: number;
}

/**
 * What one run of the step did. When the instance-wide daily cap stopped it, the rest wait
 * unclaimed (08 §4) and how many were due isn't reported: it is only the first page of them.
 */
export type NudgeReport =
  | (NudgeCounts & { readonly capped: false; readonly due: number })
  | (NudgeCounts & { readonly capped: true });

export interface NudgeStepOptions {
  readonly platform: Platform;
  readonly registry: GameRegistry;
  readonly keys: () => Promise<Subkeys>;
  /** Nudges one run sends at most; the runtime's per-invocation budget bounds it (09 §3). */
  readonly perRun: number;
}

/** Names by seat and the other seated players' names (02 §5), for the recipient's seat. */
async function seatNames(
  repos: Repositories,
  nudge: DueNudge,
): Promise<{ names: string[]; opponents: string[] }> {
  const seated = seatedRows(await repos.games.players(nudge.gameId));
  const users = new Map(
    (
      await repos.users.findByIds(
        seated.flatMap((row) => (row.userId === null ? [] : [row.userId])),
      )
    ).map((user) => [user.id, user]),
  );
  const names = namesBySeat(seated, users, nudge.seat);
  const opponents = seated
    .filter((row) => row.seat !== nudge.seat)
    .map((row) => playerName(row, users));
  return { names, opponents };
}

async function buildNudge(
  repos: Repositories,
  options: { readonly appName: string; readonly publicUrl: string; readonly gameName: string },
  keys: Subkeys,
  nudge: DueNudge,
) {
  const { names, opponents } = await seatNames(repos, nudge);
  const [last] = await repos.games.lastActions([nudge.gameId]);
  const token = await unsubscribeToken(keys, { purpose: "nudges", emailId: nudge.emailId });
  return nudgeEmail(nudge.email, {
    appName: options.appName,
    gameName: options.gameName,
    opponents,
    lastMove: last === undefined ? null : renderStoredText(last.describe, names),
    gameUrl: new URL(`/g/${encodeURIComponent(nudge.gameId)}`, options.publicUrl).toString(),
    settingsUrl: new URL("/settings", options.publicUrl).toString(),
    unsubscribeUrl: unsubscribeUrl(options.publicUrl, token),
  });
}

/** Sends the nudges due now. Failures of single nudges are logged and counted, never thrown. */
export async function sendDueNudges(options: NudgeStepOptions): Promise<NudgeReport> {
  const { platform, registry } = options;
  const { repos, config, log } = platform;
  const now = platform.now().getTime();
  const window: NudgeWindow = {
    idleSince: now - NUDGE_IDLE_MS,
    nudgedBefore: now - NUDGE_INTERVAL_MS,
  };
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  // The room left today, read without counting: only nudges actually claimed are counted (08 §4).
  const [global] = await checkLimits(repos, config, now, [
    { name: "NUDGE_EMAILS_PER_DAY", key: "all", amount: 0 },
  ]);
  let room = global === undefined ? 0 : Math.floor(global.limit - global.estimate);
  if (room <= 0) {
    await alertOncePerWindow(repos, log, "NUDGE_EMAILS_PER_DAY", now);
    return { sent, failed, skipped, capped: true };
  }
  const installed = registry
    .all()
    .flatMap((type) => type.versions.map((gameVersion) => ({ gameType: type.type, gameVersion })));
  const due = await repos.nudges.due(window, options.perRun, installed);
  let capped = false;
  for (const nudge of due) {
    if (room <= 0) {
      capped = true;
      break;
    }
    // The recipient's own daily cap (08 §4): over it, the nudge waits unclaimed.
    const [recipient] = await checkLimits(repos, config, now, [
      { name: "NUDGE_EMAILS_PER_USER_PER_DAY", key: nudge.userId, amount: 0 },
    ]);
    if (recipient?.exceeded !== false) {
      skipped++;
      continue;
    }
    if (!(await repos.nudges.claim(nudge.playerId, now, window))) {
      skipped++;
      continue;
    }
    const [counted] = await checkLimits(repos, config, now, [
      { name: "NUDGE_EMAILS_PER_DAY", key: "all", amount: 1 },
      { name: "NUDGE_EMAILS_PER_USER_PER_DAY", key: nudge.userId, amount: 1 },
    ]);
    // The room was read once for the run; an overlapping run may have used it since. A claimed
    // nudge whose count goes over the cap isn't sent (lost for the day like a failed send), so no
    // fixed UTC day sends more than the cap (08 §4.2).
    if (counted?.exceeded !== false) {
      failed++;
      capped = true;
      break;
    }
    room--;
    try {
      const message = await buildNudge(
        repos,
        {
          appName: config.appName,
          publicUrl: config.publicUrl,
          // due() returns only installed types, so the name is always there.
          gameName: registry.get(nudge.gameType)?.manifest.name ?? nudge.gameType,
        },
        await options.keys(),
        nudge,
      );
      await platform.email.send(message);
      sent++;
    } catch (error) {
      failed++;
      // A provider that already alerted for this failure isn't logged twice (09 §2); otherwise
      // the class only, never the message, which may quote the address (09 §5).
      if (!wasAlerted(error)) {
        log.error("email nudge not sent", {
          errorClass: error instanceof Error ? error.constructor.name : typeof error,
        });
      }
    }
  }
  if (capped) {
    await alertOncePerWindow(repos, log, "NUDGE_EMAILS_PER_DAY", now);
    return { sent, failed, skipped, capped: true };
  }
  return { due: due.length, sent, failed, skipped, capped: false };
}
