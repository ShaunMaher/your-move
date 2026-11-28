/**
 * Background work after the response (03 §4, 06 §3.2): through the request's `waitUntil` (per
 * request on Workers, tracked on Node), started on a later macrotask so it never delays the
 * response. Errors are logged by class only.
 */
import type { Context } from "hono";

import { wasAlerted } from "../email/sender.js";
import type { Platform } from "../platform.js";

/**
 * Logs a failed background task by class, unless its provider already logged its own alert for
 * this failure (09 §2).
 */
export function logBackgroundFailure(platform: Platform, error: unknown): void {
  if (wasAlerted(error)) return;
  platform.log.error("background task failed", {
    errorClass: error instanceof Error ? error.name : typeof error,
  });
}

export function background(c: Context, platform: Platform, task: () => Promise<unknown>): void {
  const run = new Promise((resolve) => setTimeout(resolve, 0))
    .then(task)
    .catch((error: unknown) => {
      logBackgroundFailure(platform, error);
    });
  let context: { waitUntil(promise: Promise<unknown>): void } | null = null;
  try {
    context = c.executionCtx;
  } catch {
    // No execution context (a bare `app.request` in a test): the task simply runs detached.
  }
  context?.waitUntil(run);
}
