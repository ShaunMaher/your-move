/**
 * The Worker's app and sweep with its per-invocation budgets (docs/spec/09-operations.md §3):
 * what one request or one Cron Trigger invocation may do, inside the Free plan's per-invocation D1
 * query limit. Re-measured at the first Workers deployment (10).
 */
import { createApp, createSweep, type InstalledGame, type Platform } from "@your-move/server";

/**
 * What one Cron Trigger invocation does at most (03 §7, §8; 09 §3 has the arithmetic): one overdue
 * lobby expired (at most 4 statements and one per typed address), one email-invite seat claimed
 * (5) and 2 email nudges (10 each, and up to 5 per run), 35 for a two-seat game.
 */
const WORKER_NUDGES_PER_RUN = 2;
const WORKER_CLAIMS_PER_RUN = 1;
const WORKER_LOBBIES_PER_RUN = 1;
/**
 * Email-invite seats the request completing onboarding claims at most (06 §6.4): 4 statements
 * each, so 8 keep the request at about 36 (09 §3); the sweep claims the rest.
 */
const WORKER_ONBOARDING_CLAIMS = 8;

export interface Built {
  readonly app: ReturnType<typeof createApp>;
  readonly sweep: ReturnType<typeof createSweep>;
}

/** The core app and sweep over the Worker's platform, with the Worker's budgets. */
export function workerRuntime(platform: Platform, games: readonly InstalledGame[]): Built {
  return {
    app: createApp({ platform, games, onboardingClaims: WORKER_ONBOARDING_CLAIMS }),
    sweep: createSweep({
      platform,
      games,
      nudgesPerRun: WORKER_NUDGES_PER_RUN,
      claimsPerRun: WORKER_CLAIMS_PER_RUN,
      lobbiesPerRun: WORKER_LOBBIES_PER_RUN,
    }),
  };
}
