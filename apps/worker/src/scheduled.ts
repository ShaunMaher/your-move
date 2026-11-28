/**
 * The Worker's Cron Trigger run (docs/spec/03-architecture.md §8, 09 §3): one sweep. The sweep
 * logs its own failures and never rejects; a run with any (or a Worker that couldn't be built) is
 * reported as a failed invocation, so it shows in the trigger's history, and isn't retried: the
 * next run is 15 minutes away and every step is idempotent.
 */
import type { Sweep } from "@your-move/server";

/** The part of the runtime's `ScheduledController` used here. */
interface Controller {
  noRetry(): void;
}

export async function runScheduled(controller: Controller, sweep: Sweep | null): Promise<void> {
  const report = sweep === null ? null : await sweep();
  const nudges = report?.nudges ?? null;
  if (report?.lobbies == null || report.claims === null || nudges === null || nudges.failed > 0) {
    controller.noRetry();
    throw new Error("the sweep did not complete cleanly; its log says why");
  }
}
