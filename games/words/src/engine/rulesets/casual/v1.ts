/**
 * Ruleset `casual`, version 1 (docs/spec/games/words.md §8.3): modelled on the popular mobile
 * game, with the Q17 choices (`returnThenDraw`, swap needs 7 tiles in the bag, 6 scoreless
 * turns). Immutable once released; a change is a new version beside this one (words §8.2).
 *
 * Tiles: table B, 104 tiles including 2 blanks.
 *
 * Premium layout: our own arrangement (Q15), symmetric under a quarter turn (but not a mirror),
 * with no two premium squares side by side and approximately the reference game's counts; the
 * start square carries no premium:
 *   8 TW · 12 DW · 16 TL · 24 DL = 60 premium squares.
 * An opening word of up to 7 letters covers no word premium (×1), and no word of up to 7 letters
 * covers more than ×3 (words §8.2).
 */
import type { RulesetData } from "../schema.js";

export const casualV1 = {
  id: "casual",
  version: 1,
  name: "Casual",
  description:
    "Mobile-style rules: 104 tiles, higher letter values, a 35-point bonus for using all seven, and swaps that may redraw your own tiles.",
  language: "en",
  boardSize: 15,
  start: [7, 7],
  rackSize: 7,
  bingoBonus: 35,
  swapMinBag: 7,
  swapOrder: "returnThenDraw",
  scorelessTurnLimit: 6,
  minPlayers: 2,
  maxPlayers: 2,
  tiles: {
    a: { count: 9, points: 1 },
    b: { count: 2, points: 4 },
    c: { count: 2, points: 4 },
    d: { count: 5, points: 2 },
    e: { count: 13, points: 1 },
    f: { count: 2, points: 4 },
    g: { count: 3, points: 3 },
    h: { count: 4, points: 3 },
    i: { count: 8, points: 1 },
    j: { count: 1, points: 10 },
    k: { count: 1, points: 5 },
    l: { count: 4, points: 2 },
    m: { count: 2, points: 4 },
    n: { count: 5, points: 2 },
    o: { count: 8, points: 1 },
    p: { count: 2, points: 4 },
    q: { count: 1, points: 10 },
    r: { count: 6, points: 1 },
    s: { count: 5, points: 1 },
    t: { count: 7, points: 1 },
    u: { count: 4, points: 2 },
    v: { count: 2, points: 5 },
    w: { count: 2, points: 4 },
    x: { count: 1, points: 8 },
    y: { count: 2, points: 3 },
    z: { count: 1, points: 10 },
    "?": { count: 2, points: 0 },
  },
  // . normal · d DL · t TL · D DW · T TW
  premiums: [
    "..T..t...T..t..",
    "....D..d...d...",
    "t..d..D...t...T",
    ".d...d..D...d..",
    "..t....d.d...D.",
    "T...d...t..d..t",
    "...D.t......D..",
    ".d..d.....d..d.",
    "..D......t.D...",
    "t..d..t...d...T",
    ".D...d.d....t..",
    "..d...D..d...d.",
    "T...t...D..d..t",
    "...d...d..D....",
    "..t..T...t..T..",
  ],
} satisfies RulesetData;
