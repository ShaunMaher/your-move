/**
 * The view-level play analysis (words §10.4, §10.5, 07 §3): from a `View` alone it agrees with the
 * engine's own `validate` and `preview` on the full state, for legal and illegal plays alike.
 */
import { isGameError, type Resources } from "@your-move/sdk";
import { describe, expect, it } from "vitest";

import { board, play, rack, ruleset, state } from "../test-support.js";
import { analyseViewPlay } from "./analysis.js";
import { view } from "./present.js";
import { preview, validate } from "./rules.js";
import type { Placement, View } from "./schemas.js";

const CLASSIC = ruleset("classic");
const [SR, SC] = CLASSIC.start;
/** Every word is in this dictionary, so only placement and scoring are compared. */
const ANY_WORD: Resources = {
  dictionary: { id: "any", version: 1, has: () => true },
};

const withCat = state({
  racks: [rack("sxe?abc"), rack("eeeeeee")],
  board: board(CLASSIC, [{ row: SR, col: SC - 1, word: "cat" }]),
});
const mine = view(withCat, 0);

const PLAYS: Record<string, readonly Placement[]> = {
  "extends a word": [{ row: SR, col: SC + 2, tile: "s" }],
  "plays a blank with its letter": [{ row: SR + 1, col: SC, tile: "?", letter: "x" }],
  "forms cross-words": [
    { row: SR + 1, col: SC - 1, tile: "a" },
    { row: SR + 1, col: SC, tile: "b" },
  ],
  "is out of line": [
    { row: SR + 1, col: SC, tile: "a" },
    { row: SR + 2, col: SC + 1, tile: "b" },
  ],
  "leaves a gap": [
    { row: SR + 1, col: SC - 1, tile: "a" },
    { row: SR + 3, col: SC - 1, tile: "b" },
  ],
  "uses a tile not in the rack": [{ row: SR, col: SC + 2, tile: "z" }],
  "covers a tile": [{ row: SR, col: SC, tile: "a" }],
  "leaves a blank without a letter": [{ row: SR + 1, col: SC, tile: "?" }],
  "touches nothing": [{ row: 0, col: 0, tile: "a" }],
  "runs off the board": [{ row: 15, col: 0, tile: "a" }],
};

describe("analyseViewPlay", () => {
  it.each(Object.entries(PLAYS))(
    "agrees with validate and preview on a play that %s",
    (_name, placements) => {
      const action = { type: "play" as const, placements: [...placements] };
      const local = analyseViewPlay(mine, placements);
      const checked = validate(withCat, 0, action, ANY_WORD);
      const previewed = preview(withCat, 0, action, ANY_WORD);
      if (isGameError(local)) {
        expect(checked).toEqual(local);
        expect(previewed).toEqual(local);
      } else {
        expect(checked).toEqual({ ok: true });
        expect(previewed).toEqual(local);
      }
    },
  );

  it("scores an opening play with its premiums and bingo bonus from the view alone", () => {
    const opening = state({ racks: [rack("jostled"), rack("eeeeeee")] });
    const placements = play([{ row: SR, col: SC, word: "jostled" }]).placements;
    const analysis = analyseViewPlay(view(opening, 0), placements);
    expect(isGameError(analysis)).toBe(false);
    expect(analysis).toMatchObject({ bingo: true });
    expect(analysis).toEqual(preview(opening, 0, { type: "play", placements }, ANY_WORD));
  });

  it("refuses an empty play as too few tiles", () => {
    expect(analyseViewPlay(mine, [])).toEqual({
      code: "INVALID_PLACEMENT",
      detail: "TOO_FEW_TILES",
    });
  });

  it("refuses the public view, which has no rack", () => {
    expect(analyseViewPlay(view(withCat, null), PLAYS["extends a word"] ?? [])).toEqual({
      code: "NOT_TO_ACT",
    });
  });

  it("refuses a ruleset version it doesn't know", () => {
    const future: View = { ...mine, ruleset: { id: "classic", version: 99 } };
    expect(analyseViewPlay(future, PLAYS["extends a word"] ?? [])).toEqual({
      code: "UNKNOWN_RULESET",
    });
  });
});
