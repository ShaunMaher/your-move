/**
 * The no-play hint (docs/spec/games/words.md §10.8, 07 §2): on the player's turn, the engine's
 * exhaustive search over their own rack, the board and the game's `public` word list, run in
 * slices that yield to the browser, once per game version and rack. The board says "no word can
 * be played" only when the search finished and found nothing; when it can't finish within its
 * step limit, or fails, or there is no list, it says nothing. Only the kind of answer is kept: a
 * play the search found is never shown (words §10.8).
 */
import { useEffect, useRef, useState } from "react";

import {
  HINT_MAX_STEPS,
  searchPlays,
  type Lexicon,
  type PlaySearch,
  type Ruleset,
  type SearchOutcome,
  type View,
} from "../engine/index.js";

/** Steps per slice: about a millisecond on a laptop, several on a slow phone (words §10.8). */
const HINT_SLICE_STEPS = 5_000;
/** While a tile is being dragged the search waits, looking again this often. */
const PAUSED_MS = 200;

const NO_PLAY_SWAP = "No word can be played with your tiles. Try swapping some.";
const NO_PLAY_PASS = "No word can be played with your tiles. You can pass.";

/** What the search said for one version of the game and one rack: only whether there is none. */
interface Answer {
  readonly key: string;
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
  /** While true (a tile is being dragged), no slice runs. */
  readonly paused: { readonly current: boolean };
}): string | null {
  const { active, version, ruleset, view, lexicon, paused } = input;
  const [answer, setAnswer] = useState<Answer | null>(null);
  const rack = view.yourRack?.join("") ?? null;
  const key = `${String(version)}:${rack ?? ""}`;
  const known = answer?.key === key;
  // The board is read when the search starts: a new board always comes with a new version.
  const latest = useRef(view);
  useEffect(() => {
    latest.current = view;
  });

  useEffect(() => {
    if (!active || lexicon === null || known || rack === null) return undefined;
    let search: PlaySearch | null = null;
    let timer = setTimeout(function slice() {
      if (paused.current) {
        timer = setTimeout(slice, PAUSED_MS);
        return;
      }
      let outcome: SearchOutcome | null;
      try {
        search ??= searchPlays({
          ruleset,
          board: latest.current.board,
          rack: rack.split(""),
          lexicon,
          maxSteps: HINT_MAX_STEPS,
        });
        outcome = search.advance(HINT_SLICE_STEPS);
      } catch {
        // A failing search proves nothing: the board stays silent.
        outcome = { kind: "unknown" };
      }
      if (outcome === null) timer = setTimeout(slice, 0);
      else setAnswer({ key, none: outcome.kind === "none" });
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [active, lexicon, known, key, rack, ruleset, paused]);

  if (!active || answer?.key !== key || !answer.none) return null;
  return view.bagCount >= ruleset.swapMinBag ? NO_PLAY_SWAP : NO_PLAY_PASS;
}
