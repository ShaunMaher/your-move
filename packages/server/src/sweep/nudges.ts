/**
 * The sweep's "send due email nudges" step (docs/spec/03-architecture.md §7, §8; alpha A6): an
 * "It's your turn" email to each seat that has waited 24 h in `toAct`, at most once a day per game,
 * for users who turned nudges on. Each nudge is claimed (`last_nudged_at`) before it is sent, so
 * two sweeps never both send one and a failed send isn't retried that day (Q27).
 *
 * The email carries only the game type's name, display names and the last public `describe` text
 * (08 T18): the game's state, options and scores are never read here.
 */
import { TextSchema } from "@your-move/shared";

import type { Subkeys } from "../crypto/subkeys.js";
import type { DueNudge, NudgeWindow, Repositories } from "../db/repositories.js";
import { wasAlerted } from "../email/sender.js";
import { nudgeEmail } from "../email/templates.js";
import { unsubscribeToken, unsubscribeUrl } from "../email/unsubscribe-token.js";
import type { InstalledGame } from "../games/registry.js";
import type { Platform } from "../platform.js";

const HOUR = 60 * 60 * 1000;
/** How long a seat waits in `toAct` before it is nudged (03 §7). */
const NUDGE_IDLE_MS = 24 * HOUR;
/** At most one nudge per game per this long, for each seat (03 §7). */
const NUDGE_INTERVAL_MS = 24 * HOUR;
/** Nudges one run sends at most; the rest wait for the next run (03 §7). */
const NUDGES_PER_RUN = 100;

/** What one run of the step did. */
export interface NudgeReport {
  /** Seats found due. */
  readonly due: number;
  readonly sent: number;
  /** Claimed, but building or sending the email failed: that day's nudge is lost. */
  readonly failed: number;
  /** Not claimed: the game isn't installed, or the seat moved on or was claimed meanwhile. */
  readonly skipped: number;
}

export interface NudgeStepOptions {
  readonly platform: Platform;
  readonly games: readonly InstalledGame[];
  readonly keys: () => Promise<Subkeys>;
}

/** The installed game type of a game, if this build still has its rules version (02 §7.3). */
function installedFor(games: readonly InstalledGame[], nudge: DueNudge): InstalledGame | undefined {
  const game = games.find((candidate) => candidate.manifest.type === nudge.gameType);
  const versions = Object.values(game?.engines ?? {}).map((definition) => definition.version);
  return versions.includes(nudge.gameVersion) ? game : undefined;
}

/** A stored `describe` text with the names filled in, or null if it can't be read. */
function renderDescribe(stored: string, names: ReadonlyMap<number, string>): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  const text = TextSchema.safeParse(parsed);
  if (!text.success) return null;
  return text.data
    .map((part) =>
      typeof part === "string" ? part : (names.get(part.seat) ?? `Seat ${String(part.seat + 1)}`),
    )
    .join("");
}

/** The fallback for a display name that isn't set (04 `users.display_name`). */
const NO_NAME = "New player";

async function buildNudge(
  repos: Repositories,
  options: { readonly appName: string; readonly publicUrl: string; readonly gameName: string },
  keys: Subkeys,
  nudge: DueNudge,
) {
  const players = await repos.games.players(nudge.gameId);
  const seated = players.filter(
    (row) => row.seat !== null && (row.state === "playing" || row.state === "out"),
  );
  const users = new Map(
    (
      await repos.users.findByIds(
        seated.flatMap((row) => (row.userId === null ? [] : [row.userId])),
      )
    ).map((user) => [user.id, user]),
  );
  const names = new Map<number, string>();
  const opponents: string[] = [];
  for (const row of seated) {
    if (row.seat === null || row.userId === null) continue;
    if (row.seat === nudge.seat) {
      names.set(row.seat, "You");
      continue;
    }
    const user = users.get(row.userId);
    if (user === undefined) continue;
    const name = user.displayName ?? NO_NAME;
    names.set(row.seat, name);
    opponents.push(name);
  }
  const [last] = await repos.games.lastActions([nudge.gameId]);
  const token = await unsubscribeToken(keys, { purpose: "nudges", emailId: nudge.emailId });
  return nudgeEmail(nudge.email, {
    appName: options.appName,
    gameName: options.gameName,
    opponents,
    lastMove: last === undefined ? null : renderDescribe(last.describe, names),
    gameUrl: new URL(`/g/${encodeURIComponent(nudge.gameId)}`, options.publicUrl).toString(),
    settingsUrl: new URL("/settings", options.publicUrl).toString(),
    unsubscribeUrl: unsubscribeUrl(options.publicUrl, token),
  });
}

/** Sends the nudges due now. Failures of single nudges are logged and counted, never thrown. */
export async function sendDueNudges(options: NudgeStepOptions): Promise<NudgeReport> {
  const { platform, games } = options;
  const { repos, config, log } = platform;
  const now = platform.now().getTime();
  const window: NudgeWindow = {
    idleSince: now - NUDGE_IDLE_MS,
    nudgedBefore: now - NUDGE_INTERVAL_MS,
  };
  const due = await repos.nudges.due(window, NUDGES_PER_RUN);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const nudge of due) {
    const game = installedFor(games, nudge);
    // An orphaned game can't be played (02 §7.3): nothing to nudge about.
    if (game === undefined || !(await repos.nudges.claim(nudge.playerId, now, window))) {
      skipped++;
      continue;
    }
    try {
      const message = await buildNudge(
        repos,
        { appName: config.appName, publicUrl: config.publicUrl, gameName: game.manifest.name },
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
          errorClass: error instanceof Error ? error.name : typeof error,
        });
      }
    }
  }
  return { due: due.length, sent, failed, skipped };
}
