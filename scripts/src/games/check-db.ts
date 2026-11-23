/**
 * Helpers for `pnpm games:check-db` (docs/spec/02-game-framework.md §7.3). The orphan logic and
 * the fixed query live in `@your-move/server`, shared with the Node startup check.
 */
import { liveGameSchema, type LiveGame } from "@your-move/server";
import { z } from "zod";

/** Parses `wrangler d1 execute --json` output for the fixed query. */
export function parseD1Output(stdout: string): LiveGame[] {
  const parsed = z
    .array(z.object({ results: z.array(z.unknown()), success: z.boolean() }))
    .parse(JSON.parse(stdout));
  return parsed.flatMap((batch) => batch.results.map((row) => liveGameSchema.parse(row)));
}

/** Whether an error from either driver means the `games` table doesn't exist yet. */
export function isMissingGamesTable(message: string): boolean {
  return /no such table:\s*games\b/u.test(message);
}
