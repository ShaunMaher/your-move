/**
 * The no-play hint (docs/spec/games/words.md §10.8, 07 §2): on the player's turn, the engine's
 * exhaustive search over their own rack, the board and the game's `public` word list, run in
 * slices that yield to the browser, once per game version. The board says "no word can be played"
 * only when the search finished and found nothing; when it can't finish within its step limit,
 * or fails, or there is no list, it says nothing.
 */
import { useEffect, useState } from "react";

import {
  HINT_MAX_STEPS,
  searchPlays,
  type Lexicon,
  type Ruleset,
  type SearchOutcome,
  type View,
} from "../engine/index.js";

/** Steps per slice: about half a millisecond on a laptop, a few on a slow phone (words §10.8). */
const HINT_SLICE_STEPS = 5_000;

const NO_PLAY_SWAP = "No word can be played with your tiles. Try swapping some.";
const NO_PLAY_PASS = "No word can be played with your tiles. You can pass.";

/** What the search said for one version of the game. */
interface Answer {
  readonly version: number;
  readonly none: boolean;
}

/**
 * The hint for the viewer's rack on this version of the game, or null: off turn, without a list,
 * while the search runs, when there is a play, or when the search couldn't tell.
 */
export function useNoPlayHint(input: {
  /** Whether it is the viewer's turn in an active game, with a rack. */
  readonly active: boolean;
  readonly version: number;
  readonly ruleset: Ruleset;
  readonly view: View;
  readonly lexicon: Lexicon | null;
}): string | null {
  const { active, version, ruleset, view, lexicon } = input;
  const [answer, setAnswer] = useState<Answer | null>(null);
  const known = answer?.version === version;
  const { board, yourRack } = view;

  useEffect(() => {
    if (!active || lexicon === null || known || yourRack === null) return undefined;
    const search = searchPlays({
      ruleset,
      board,
      rack: yourRack,
      lexicon,
      maxSteps: HINT_MAX_STEPS,
    });
    let timer = setTimeout(function slice() {
      let outcome: SearchOutcome | null;
      try {
        outcome = search.advance(HINT_SLICE_STEPS);
      } catch {
        // A failing search proves nothing: the board stays silent.
        outcome = { kind: "unknown" };
      }
      if (outcome === null) timer = setTimeout(slice, 0);
      else setAnswer({ version, none: outcome.kind === "none" });
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [active, lexicon, known, version, ruleset, board, yourRack]);

  if (!active || answer?.version !== version || !answer.none) return null;
  return view.bagCount >= ruleset.swapMinBag ? NO_PLAY_SWAP : NO_PLAY_PASS;
}
