/**
 * Invite claims (docs/spec/06-auth.md §6.4, 02 §4 Invite claims, alpha A17): when someone completes
 * onboarding with an address, every email-invite seat typed as that address becomes their
 * invitation, and the sweep (03 §8) claims any it finds later. A claim is a row-level update, not
 * a game transition: it checks the game's version without bumping it and changes nothing the
 * creator or any other member can see (the row still shows the typed address, or "Invited"); only
 * the claimant's own game list gains the invitation. The callers send the claimant the generic
 * invitation push for a `normal` one (06 §6.4, alpha A20), never an email.
 *
 * The block rule is checked against the creator and every other row with a user (a block either
 * way makes the claimed row `inert`); the inbound cap is not counted again: the row keeps the
 * delivery it was given when the game was created (06 §6.7).
 */
import type { NormalisedEmail } from "../accounts/email.js";
import type { ClaimableSeat, Repositories } from "../db/repositories.js";
import { LOBBY_LIFETIME_MS, lobbyExpiresAt, SERVER_ATTEMPTS as ATTEMPTS } from "./lifecycle.js";

/** Who claims: an onboarded human and the address they completed onboarding with. */
export interface Claimant {
  readonly id: string;
  readonly email: NormalisedEmail;
}

/** What a claim made of the seat: the claimed row's delivery, or null when nothing was claimed. */
export type Claimed = "normal" | "hidden" | "inert" | null;

/**
 * Claims one seat for the claimant, retrying when the game's version moved between the block
 * check and the claim. Null when the seat can't be claimed (any more): the lobby ended or is due
 * to expire, the row was taken, removed or made `inert`, or the claimant holds another row;
 * otherwise the claimed row's delivery (`inert` when a block made it so).
 */
export async function claimSeat(
  repos: Repositories,
  seat: ClaimableSeat,
  claimant: Claimant,
  now: number,
): Promise<Claimed> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const loaded = await repos.games.load(seat.gameId);
    if (loaded === null) return null;
    const { game, players } = loaded;
    // A lobby at or past its expiry is about to end (02 §4): nothing is claimed into it.
    if (game.status !== "lobby" || now >= lobbyExpiresAt(game)) return null;
    const row = players.find((player) => player.id === seat.playerId);
    if (
      row?.state !== "invited" ||
      row.userId !== null ||
      row.delivery === "inert" ||
      row.inviteEmail !== claimant.email ||
      players.some((player) => player.userId === claimant.id)
    ) {
      return null;
    }
    // The full block rule against the creator and every other row with a user (06 §6.4).
    const others = players.flatMap((player) => (player.userId === null ? [] : [player.userId]));
    const blocks = await repos.users.blocksAmong([claimant.id, ...others]);
    const inert = blocks.some(
      (pair) => pair.blockerId === claimant.id || pair.blockedId === claimant.id,
    );
    const claimed = await repos.invites.claim({
      playerId: seat.playerId,
      gameId: seat.gameId,
      userId: claimant.id,
      email: claimant.email,
      expectedVersion: game.version,
      inert,
    });
    if (claimed) return inert ? "inert" : row.delivery;
    // The guard failed: reload, and claim if it still applies (a moved version), else stop.
  }
  return null;
}

/**
 * Claims the seats typed as the claimant's address (06 §6.4), at most `limit` of them, oldest
 * lobby first (the runtime's per-request budget, 09 §3); the sweep claims any others. Returns how
 * many it claimed, and how many of those are `normal` invitations (for the invitation push).
 */
export async function claimInvitations(
  repos: Repositories,
  claimant: Claimant,
  now: number,
  limit: number,
): Promise<{ readonly claimed: number; readonly normal: number }> {
  const seats = await repos.invites.claimable(claimant.email, now - LOBBY_LIFETIME_MS, limit);
  let claimed = 0;
  let normal = 0;
  for (const seat of seats) {
    const delivery = await claimSeat(repos, seat, claimant, now);
    if (delivery !== null) claimed++;
    if (delivery === "normal") normal++;
  }
  return { claimed, normal };
}
