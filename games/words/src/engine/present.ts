/**
 * Presenting the game: views, list summaries and history text (docs/spec/games/words.md §7,
 * §10.4, §10.6; 02 §2 "Presenting", §2.1 rules 4, 5 and 9).
 *
 * Secrecy (words §7): while the game is in progress a viewer sees the board, every score, the
 * number of tiles in each rack and in the bag, the last move, and only their own rack. Once the
 * game is over every rack is revealed. Racks are shown sorted, so a rack never shows the order
 * its tiles were drawn in, and the bag's contents and order are never shown at all.
 */
import type { ListSummary, Seat, Text } from "@your-move/sdk";

import { at } from "./at.js";
import { BLANK } from "./rulesets/schema.js";
import type { PublicRecord, ScoredWord, View } from "./schemas.js";
import type { State } from "./state.js";

/** A rack in display order: letters a–z, then blanks. */
export function sortedRack(rack: readonly string[]): string[] {
  return [...rack].sort((a, b) => {
    if (a === b) return 0;
    if (a === BLANK) return 1;
    if (b === BLANK) return -1;
    return a < b ? -1 : 1;
  });
}

/** What `viewer` may see; `null` is the public view (02 §2 `view`, words §10.4). */
export function view(state: State, viewer: Seat | null): View {
  const { options, finished } = state;
  return {
    ruleset: { id: options.rulesetId, version: options.rulesetVersion },
    dictionary: { id: options.dictionaryId, version: options.dictionaryVersion },
    board: state.board.map((row) =>
      row.map((square) =>
        square === null
          ? null
          : { tile: square.tile, letter: square.letter, blank: square.tile === BLANK },
      ),
    ),
    scores: [...state.scores],
    rackCounts: state.racks.map((rack) => rack.length),
    bagCount: state.bag.length,
    yourRack: viewer === null ? null : sortedRack(at(state.racks, viewer)),
    lastMove: state.lastMove,
    ...(finished === null
      ? {}
      : {
          final: {
            reason: finished.reason,
            adjustments: [...finished.adjustments],
            racks: state.racks.map(sortedRack),
          },
        }),
  };
}

/**
 * One line for the game list (words §10.6): `[{seat:0}, " 212 – 187 ", {seat:1}]`, rendered as
 * "You 212 – 187 Sam". With more seats, each seat is followed by its score.
 */
export function summary(state: State): ListSummary {
  const scores = [...state.scores];
  if (scores.length === 2) {
    return {
      headline: [{ seat: 0 }, ` ${String(scores[0])} – ${String(scores[1])} `, { seat: 1 }],
      scores,
    };
  }
  const headline: (string | { seat: Seat })[] = [];
  scores.forEach((score, seat) => {
    if (seat > 0) headline.push(", ");
    headline.push({ seat }, ` ${String(score)}`);
  });
  return { headline, scores };
}

/**
 * The word a play's history text names: the main word of a multi-tile play (always listed
 * first); for a single tile, which has no play line (words §3.1 rule 6), the longest word it
 * formed, the higher-scoring one on a tie, then the first.
 */
function namedWord(words: readonly ScoredWord[], tiles: number): string {
  const ranked =
    tiles === 1
      ? [...words].sort((a, b) => b.word.length - a.word.length || b.score - a.score)
      : words;
  return at(ranked, 0).word;
}

/** History and notification text, from the record alone (02 §5, §2.1 rule 9; words §10.6). */
export function describe(record: PublicRecord): Text {
  const who = { seat: record.seat };
  switch (record.type) {
    case "play": {
      const main = namedWord(record.words, record.placements.length).toUpperCase();
      const bingo = record.bingo ? ", using every tile" : "";
      return [who, ` played ${main} for ${String(record.score)}${bingo}`];
    }
    case "swap": {
      const count = record.swapCount;
      return [who, ` swapped ${String(count)} ${count === 1 ? "tile" : "tiles"}`];
    }
    case "pass":
      return [who, " passed"];
    case "resign":
      return [who, " resigned"];
    case "timeout":
      return [who, " ran out of time"];
    case "decline":
      return [who, " declined the game"];
  }
}
