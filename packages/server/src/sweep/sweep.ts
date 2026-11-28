/**
 * The one `sweep()` (docs/spec/03-architecture.md §8): scheduled work, run by the Worker's Cron
 * Trigger or a Node `setInterval`. The alpha has four steps: expiring overdue lobbies and claiming
 * pending email-invite seats (A17), deleting expired join links (A18), then sending due email
 * nudges (A6); the others arrive with their milestones. A failing step is logged by class and the rest still run.
 */
import { deriveSubkeys, type Subkeys } from "../crypto/subkeys.js";
import { instanceGames } from "../games/instance.js";
import type { InstalledGame } from "../games/registry.js";
import type { Platform } from "../platform.js";
import { type ClaimReport, claimPendingInvites } from "./claims.js";
import { expireOverdueLobbiesStep } from "./lobbies.js";
import { type NudgeReport, sendDueNudges } from "./nudges.js";

export interface SweepOptions {
  readonly platform: Platform;
  /** The generated registry, as `createApp` gets it. */
  readonly games: readonly InstalledGame[];
  /**
   * Email nudges one run sends at most (03 §7). The runtime's budget for one invocation bounds
   * it: 100 on Node, 4 on Workers, whose subrequest and D1-query limits per Cron Trigger
   * invocation each nudge spends several of (09 §3).
   */
  readonly nudgesPerRun: number;
  /** Email-invite seats one run claims at most (03 §8); bounded the same way (09 §3). */
  readonly claimsPerRun: number;
  /** Overdue lobbies one run expires at most (03 §8); bounded the same way (09 §3). */
  readonly lobbiesPerRun: number;
  /** Expired join links one run deletes at most (03 §8): one statement however many (09 §3). */
  readonly joinLinksPerRun: number;
}

/** What one run did; a step that failed reports null. */
export interface SweepReport {
  /** Overdue lobbies looked at (each expired, unless something else ended it first). */
  readonly lobbies: number | null;
  readonly claims: ClaimReport | null;
  /** Expired join links deleted (03 §8). */
  readonly joinLinks: number | null;
  readonly nudges: NudgeReport | null;
}

export type Sweep = () => Promise<SweepReport>;

/**
 * Builds the sweep for a runtime to schedule. Each call is one run; it never rejects. Throws at
 * creation, as `createApp` does, for a configuration the games or their resources refuse.
 */
export function createSweep(options: SweepOptions): Sweep {
  const { platform } = options;
  const { registry } = instanceGames(platform, options.games);
  let subkeys: Promise<Subkeys> | null = null;
  const keys = (): Promise<Subkeys> => (subkeys ??= deriveSubkeys(platform.config.appSecret));

  async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      // The class only: a driver error's message quotes SQL parameters (09 §5).
      platform.log.error("sweep step failed", {
        step: name,
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
      });
      return null;
    }
  }

  return async () => {
    const started = platform.now().getTime();
    // Lobbies first, so nothing is claimed into one that is due to expire.
    const lobbies = await step("lobbies", () =>
      expireOverdueLobbiesStep(platform.repos, started, options.lobbiesPerRun),
    );
    const claims = await step("claims", () =>
      claimPendingInvites(platform.repos, platform.now().getTime(), options.claimsPerRun),
    );
    const joinLinks = await step("joinLinks", () =>
      platform.repos.joinLinks.deleteExpired(platform.now().getTime(), options.joinLinksPerRun),
    );
    const nudges = await step("nudges", () =>
      sendDueNudges({ platform, registry, keys, perRun: options.nudgesPerRun }),
    );
    platform.log.info("sweep finished", {
      durationMs: platform.now().getTime() - started,
      ...(lobbies === null ? { lobbiesFailedStep: true } : { lobbiesDue: lobbies }),
      ...(claims === null
        ? { claimsFailedStep: true }
        : { invitesClaimed: claims.claimed, invitesSkipped: claims.skipped }),
      ...(joinLinks === null ? { joinLinksFailedStep: true } : { joinLinksExpired: joinLinks }),
      ...(nudges === null
        ? { nudgesFailedStep: true }
        : {
            ...(nudges.capped ? {} : { nudgesDue: nudges.due }),
            nudgesSent: nudges.sent,
            nudgesFailed: nudges.failed,
            nudgesSkipped: nudges.skipped,
            nudgesCapped: nudges.capped,
          }),
    });
    return { lobbies, claims, joinLinks, nudges };
  };
}
