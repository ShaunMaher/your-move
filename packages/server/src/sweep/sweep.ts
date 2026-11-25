/**
 * The one `sweep()` (docs/spec/03-architecture.md §8): scheduled work, run by the Worker's Cron
 * Trigger or a Node `setInterval`. The alpha (A6) has one step, sending due email nudges; the
 * others arrive with their milestones. A failing step is logged by class and the rest still run.
 */
import { deriveSubkeys, type Subkeys } from "../crypto/subkeys.js";
import type { InstalledGame } from "../games/registry.js";
import type { Platform } from "../platform.js";
import { type NudgeReport, sendDueNudges } from "./nudges.js";

export interface SweepOptions {
  readonly platform: Platform;
  /** The generated registry, as `createApp` gets it. */
  readonly games: readonly InstalledGame[];
}

/** What one run did; a step that failed reports null. */
export interface SweepReport {
  readonly nudges: NudgeReport | null;
}

export type Sweep = () => Promise<SweepReport>;

/** Builds the sweep for a runtime to schedule. Each call is one run; it never rejects. */
export function createSweep(options: SweepOptions): Sweep {
  const { platform } = options;
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
    const nudges = await step("nudges", () =>
      sendDueNudges({ platform, games: options.games, keys }),
    );
    platform.log.info("sweep finished", {
      durationMs: platform.now().getTime() - started,
      ...(nudges === null
        ? { nudgesFailedStep: true }
        : {
            nudgesDue: nudges.due,
            nudgesSent: nudges.sent,
            nudgesFailed: nudges.failed,
            nudgesSkipped: nudges.skipped,
          }),
    });
    return { nudges };
  };
}
