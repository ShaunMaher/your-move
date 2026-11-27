/** An invite claim's reload-and-retry (docs/spec/02-game-framework.md §4 Invite claims). */
import { describe, expect, it } from "vitest";

import { normaliseAddress } from "../accounts/email.js";
import type { InviteClaim, LoadedGame, Repositories } from "../db/repositories.js";
import { claimSeat } from "./claim.js";

const NOW = Date.UTC(2026, 0, 1);
const email = normaliseAddress("sam@example.org");
if (email === null) throw new Error("test address is invalid");
const claimant = { id: "u-sam", email };
const seat = { playerId: "p-1", gameId: "g-1" };

/** The lobby at `version`, with its creator and the email seat typed as Sam's address. */
function lobby(version: number): LoadedGame {
  return {
    game: { id: "g-1", status: "lobby", createdAt: NOW, version },
    players: [
      { id: "p-0", userId: "u-creator", state: "joined", delivery: "normal", inviteEmail: null },
      { id: "p-1", userId: null, state: "invited", delivery: "normal", inviteEmail: email },
    ],
  } as unknown as LoadedGame;
}

/**
 * Repositories for one claim: each load reads the game one version later (another transition
 * moved it meanwhile), and the claim succeeds on the attempt numbered `succeedOn` (never if 0).
 */
function repos(succeedOn: number) {
  const claims: InviteClaim[] = [];
  let loads = 0;
  const fake = {
    games: { load: () => Promise.resolve(lobby(loads++)) },
    users: { blocksAmong: () => Promise.resolve([]) },
    invites: {
      claim: (claim: InviteClaim) => {
        claims.push(claim);
        return Promise.resolve(claims.length === succeedOn);
      },
    },
  } as unknown as Repositories;
  return { fake, claims, loads: () => loads };
}

describe("claimSeat", () => {
  it("reloads when the version moved and claims on the second attempt, from the new version", async () => {
    const { fake, claims, loads } = repos(2);
    expect(await claimSeat(fake, seat, claimant, NOW)).toBe(true);
    expect(loads()).toBe(2);
    expect(claims.map((claim) => claim.expectedVersion)).toEqual([0, 1]);
    expect(claims[1]).toEqual({
      ...seat,
      userId: "u-sam",
      email,
      expectedVersion: 1,
      inert: false,
    });
  });

  it("gives up after 3 attempts", async () => {
    const { fake, claims, loads } = repos(0);
    expect(await claimSeat(fake, seat, claimant, NOW)).toBe(false);
    expect(loads()).toBe(3);
    expect(claims).toHaveLength(3);
  });

  it("claims nothing into a lobby at its expiry, and never calls the claim", async () => {
    const { fake, claims } = repos(1);
    expect(await claimSeat(fake, seat, claimant, NOW + 14 * 86_400_000)).toBe(false);
    expect(claims).toEqual([]);
  });
});
