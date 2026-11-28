/** The sweep's own error handling (docs/spec/03-architecture.md §8). */
import { describe, expect, it } from "vitest";

import { testPlatform } from "../test-support.js";
import { createSweep } from "./sweep.js";

const PER_RUN = { nudgesPerRun: 10, claimsPerRun: 10, lobbiesPerRun: 10, joinLinksPerRun: 10 };

describe("sweep", () => {
  it("logs each failing step by class, reports it as null, runs the rest and never rejects", async () => {
    // No database: every step's first read fails.
    const platform = testPlatform();
    const report = await createSweep({ platform, games: [], ...PER_RUN })();
    expect(report).toEqual({ lobbies: null, claims: null, joinLinks: null, nudges: null });
    for (const step of ["lobbies", "claims", "joinLinks", "nudges"]) {
      expect(platform.lines).toContainEqual(
        expect.objectContaining({
          level: "error",
          msg: "sweep step failed",
          step,
          errorClass: "DetachedStorageError",
        }),
      );
    }
    expect(JSON.stringify(platform.lines)).not.toContain("no database");
    expect(platform.lines.at(-1)).toMatchObject({
      msg: "sweep finished",
      lobbiesFailedStep: true,
      claimsFailedStep: true,
      joinLinksFailedStep: true,
      nudgesFailedStep: true,
    });
  });

  it("reports what each step did", async () => {
    const platform = testPlatform();
    const repos = {
      ...platform.repos,
      rateLimits: {
        hit: (hits: readonly unknown[]) =>
          Promise.resolve(hits.map(() => ({ current: 0, previous: 0 }))),
      },
      nudges: { due: () => Promise.resolve([]), claim: () => Promise.resolve(false) },
      games: { ...platform.repos.games, allOverdueLobbies: () => Promise.resolve([]) },
      invites: { ...platform.repos.invites, pending: () => Promise.resolve([]) },
      joinLinks: { ...platform.repos.joinLinks, deleteExpired: () => Promise.resolve(2) },
    };
    const report = await createSweep({ platform: { ...platform, repos }, games: [], ...PER_RUN })();
    expect(report).toEqual({
      lobbies: 0,
      claims: { claimed: 0, skipped: 0 },
      joinLinks: 2,
      nudges: { due: 0, sent: 0, failed: 0, skipped: 0, capped: false },
    });
    expect(platform.lines.at(-1)).toMatchObject({
      msg: "sweep finished",
      lobbiesDue: 0,
      invitesClaimed: 0,
      joinLinksExpired: 2,
      nudgesSent: 0,
    });
  });
});
