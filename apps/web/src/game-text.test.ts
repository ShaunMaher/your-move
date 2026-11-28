import { describe, expect, it } from "vitest";

import { namesBySeat, seatLabel } from "./game-text.js";
import { player } from "./test-support.js";

describe("seatLabel", () => {
  it("is You for the viewer and the display name for others", () => {
    expect(seatLabel(player({ isYou: true }))).toBe("You");
    expect(seatLabel(player({ isYou: false, displayName: "Alex" }))).toBe("Alex");
  });

  it("is New player for a member without a display name (04)", () => {
    expect(seatLabel(player({ isYou: false, displayName: null, userId: "u2" }))).toBe("New player");
  });

  it("is Deleted player for a member whose account is gone (02 §5)", () => {
    for (const state of ["joined", "playing", "out"] as const) {
      expect(seatLabel(player({ isYou: false, displayName: null, userId: null, state }))).toBe(
        "Deleted player",
      );
    }
  });

  it("is A player for a row that never joined", () => {
    expect(
      seatLabel(player({ isYou: false, displayName: null, userId: null, state: "invited" })),
    ).toBe("A player");
  });
});

describe("namesBySeat", () => {
  it("never numbers a seat, and fills a gap with A player", () => {
    const names = namesBySeat([
      player({ seat: 0, isYou: false, displayName: null, userId: null }),
      player({ seat: 2, isYou: false, displayName: null, userId: "u3" }),
    ]);
    expect(names).toEqual(["Deleted player", "A player", "New player"]);
  });
});
