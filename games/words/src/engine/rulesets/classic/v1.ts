/**
 * Ruleset `classic`, version 1 (docs/spec/games/words.md §8.3): modelled on the traditional board
 * game. Immutable once released; a change is a new version beside this one (words §8.2).
 *
 * Tiles: table A, 100 tiles including 2 blanks.
 *
 * Premium layout: our own arrangement (Q15), symmetric under a quarter turn (but not a mirror),
 * with no two premium squares side by side, keeping the reference game's counts and density:
 *   8 TW · 17 DW (including the start square) · 12 TL · 24 DL = 61 premium squares.
 * An opening word of up to 7 letters covers only the start square's DW (×2), and no word of up to
 * 7 letters covers more than ×4 (words §8.2).
 */
import type { RulesetData } from "../schema.js";

export const classicV1 = {
  id: "classic",
  version: 1,
  name: "Classic",
  description: "The traditional board-game rules: 100 tiles, 50-point bonus for using all seven.",
  language: "en",
  boardSize: 15,
  start: [7, 7],
  rackSize: 7,
  bingoBonus: 50,
  swapMinBag: 7,
  swapOrder: "drawThenReturn",
  scorelessTurnLimit: 6,
  minPlayers: 2,
  maxPlayers: 2,
  tiles: {
    a: { count: 9, points: 1 },
    b: { count: 2, points: 3 },
    c: { count: 2, points: 3 },
    d: { count: 4, points: 2 },
    e: { count: 12, points: 1 },
    f: { count: 2, points: 4 },
    g: { count: 3, points: 2 },
    h: { count: 2, points: 4 },
    i: { count: 9, points: 1 },
    j: { count: 1, points: 8 },
    k: { count: 1, points: 5 },
    l: { count: 4, points: 1 },
    m: { count: 2, points: 3 },
    n: { count: 6, points: 1 },
    o: { count: 8, points: 1 },
    p: { count: 2, points: 3 },
    q: { count: 1, points: 10 },
    r: { count: 6, points: 1 },
    s: { count: 4, points: 1 },
    t: { count: 6, points: 1 },
    u: { count: 4, points: 1 },
    v: { count: 2, points: 4 },
    w: { count: 2, points: 4 },
    x: { count: 1, points: 8 },
    y: { count: 2, points: 4 },
    z: { count: 1, points: 10 },
    "?": { count: 2, points: 0 },
  },
  // . normal · d DL · t TL · D DW · T TW
  premiums: [
    "..T..d...T..d..",
    "...D..t.t.D....",
    "d...D..d...d..T",
    "..d..d...t...D.",
    ".D....D.....D..",
    "T..t....d..d..d",
    ".t...d....D..t.",
    "..d....D....d..",
    ".t..D....d...t.",
    "d..d..d....t..T",
    "..D.....D....D.",
    ".D...t...d..d..",
    "T..d...d..D...d",
    "....D.t.t..D...",
    "..d..T...d..T..",
  ],
} satisfies RulesetData;
