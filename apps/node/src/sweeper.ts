/**
 * Runs the core's `sweep()` on Node (docs/spec/03-architecture.md §8): every 15 minutes, as the
 * Worker's Cron Trigger does, first 15 minutes after start. A run still going when the next is
 * due makes that one skip, so runs never overlap; shutdown stops the timer and waits for a run in
 * progress before the database closes.
 */
import type { Sweep } from "@your-move/server";

/** The sweep's period, matching the Worker's `*\/15 * * * *` Cron Trigger. */
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** Email nudges one Node sweep run sends at most (03 §7): Node has no per-run budget to fit. */
export const NODE_NUDGES_PER_RUN = 100;

/** Email-invite seats one Node sweep run claims at most (03 §8, alpha A17). */
export const NODE_CLAIMS_PER_RUN = 100;

/** Overdue lobbies one Node sweep run expires at most (03 §8, alpha A17). */
export const NODE_LOBBIES_PER_RUN = 100;

/** Expired join links one Node sweep run deletes at most (03 §8, alpha A18). */
export const NODE_JOIN_LINKS_PER_RUN = 1000;

export interface Sweeper {
  /** Stops scheduling runs and settles once a run in progress has finished. */
  stop(): Promise<void>;
}

export function startSweeper(sweep: Sweep, intervalMs: number = SWEEP_INTERVAL_MS): Sweeper {
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (running !== null) return;
    // The sweep never rejects (it logs each failing step); the catch only keeps a bug from
    // becoming an unhandled rejection that ends the process.
    running = sweep()
      .catch(() => undefined)
      .finally(() => {
        running = null;
      });
  }, intervalMs);
  // The timer alone never keeps the process alive.
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
