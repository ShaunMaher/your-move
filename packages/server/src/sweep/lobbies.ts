/**
 * The sweep's lobby-expiry step (docs/spec/03-architecture.md §8, 02 §4, alpha A17): lobbies 14
 * days after creation end `expired` and their typed addresses are cleared (06 §6.5), so an
 * unclaimed email-invite seat's address goes with its lobby even when no one comes back to it.
 * Reads and writes still expire lobbies lazily too; this is the same transition.
 */
import type { Repositories } from "../db/repositories.js";
import { expireIfOverdue } from "../games/expiry.js";
import { LOBBY_LIFETIME_MS } from "../games/lifecycle.js";

/** Expires up to `perRun` overdue lobbies, oldest first; returns how many it looked at. */
export async function expireOverdueLobbiesStep(
  repos: Repositories,
  now: number,
  perRun: number,
): Promise<number> {
  const ids = await repos.games.allOverdueLobbies(now - LOBBY_LIFETIME_MS, perRun);
  for (const id of ids) await expireIfOverdue(repos, id, now);
  return ids.length;
}
