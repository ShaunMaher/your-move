/**
 * The sweep's invite-claim step (docs/spec/03-architecture.md §8, 06 §6.4, alpha A17): claims the
 * email-invite seats whose address belongs to an onboarded user, for games created while that
 * person was completing onboarding and claims that failed. The same claim as at onboarding, and
 * the same generic invitation push to each claimant of a `normal` invitation (alpha A20).
 */
import { claimSeat } from "../games/claim.js";
import { LOBBY_LIFETIME_MS } from "../games/lifecycle.js";
import type { Platform } from "../platform.js";
import { sendInvitationPushes } from "../push/notify.js";

export interface ClaimReport {
  /** Seats claimed. */
  readonly claimed: number;
  /** Seats found that could no longer be claimed (the lobby moved on meanwhile). */
  readonly skipped: number;
}

/**
 * Claims up to `perRun` pending seats, oldest lobby first, then pushes to their claimants. A
 * failed push is logged by class and never fails the step: the claims stand.
 */
export async function claimPendingInvites(
  platform: Platform,
  now: number,
  perRun: number,
): Promise<ClaimReport> {
  const { repos } = platform;
  const pending = await repos.invites.pending(now - LOBBY_LIFETIME_MS, perRun);
  let claimed = 0;
  const invited: string[] = [];
  for (const seat of pending) {
    const delivery = await claimSeat(repos, seat, { id: seat.userId, email: seat.email }, now);
    if (delivery !== null) claimed++;
    if (delivery === "normal") invited.push(seat.userId);
  }
  try {
    await sendInvitationPushes(platform, invited);
  } catch (error) {
    // The class only: a driver error's message quotes SQL parameters (09 §5).
    platform.log.error("invitation push after a claim failed", {
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
    });
  }
  return { claimed, skipped: pending.length - claimed };
}
