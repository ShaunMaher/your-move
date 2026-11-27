/**
 * The sweep's invite-claim step (docs/spec/03-architecture.md §8, 06 §6.4, alpha A17): claims the
 * email-invite seats whose address belongs to an onboarded user, for games created while that
 * person was completing onboarding and claims that failed. The same claim as at onboarding.
 */
import type { Repositories } from "../db/repositories.js";
import { claimSeat } from "../games/claim.js";
import { LOBBY_LIFETIME_MS } from "../games/lifecycle.js";

export interface ClaimReport {
  /** Seats claimed. */
  readonly claimed: number;
  /** Seats found that could no longer be claimed (the lobby moved on meanwhile). */
  readonly skipped: number;
}

/** Claims up to `perRun` pending seats, oldest lobby first. */
export async function claimPendingInvites(
  repos: Repositories,
  now: number,
  perRun: number,
): Promise<ClaimReport> {
  const pending = await repos.invites.pending(now - LOBBY_LIFETIME_MS, perRun);
  let claimed = 0;
  for (const seat of pending) {
    if (await claimSeat(repos, seat, { id: seat.userId, email: seat.email }, now)) claimed++;
  }
  return { claimed, skipped: pending.length - claimed };
}
