/**
 * Presenting the game: the view, list summaries and history text (docs/spec/games/pairs.md §4,
 * §8.4, §8.5; docs/spec/02-game-framework.md §2 "Presenting", §2.1 rules 4, 5 and 9).
 *
 * Secrecy: every seat and the public get the same view. While the game is in progress it shows a
 * card's face only while the card is matched, up, or in the previous turn's missed pair; once the
 * game is over it shows every face. Nothing in the view's shape follows the layout.
 */
import type { ListSummary, Seat, Text } from "@your-move/sdk";

import { at } from "./at.js";
import type { Card, PublicRecord, View } from "./schemas.js";
import { gridFor, pairsFound, pairsLeft, result, seatToAct, type State } from "./state.js";

/** What card `card` shows (pairs §4, §8.4). */
function cardView(state: State, card: number): Card {
  const face = at(state.faces, card);
  const by = at(state.matchedBy, card);
  if (by !== null) return { state: "matched", face, by };
  if (state.turned === card) return { state: "up", face, by: seatToAct(state) };
  const miss = state.lastMiss;
  if (miss?.cards.includes(card) === true) return { state: "missed", face, by: miss.seat };
  return { state: "down", face: state.endReason === null ? null : face, by: null };
}

/** The view, the same for every viewer, so it takes none (pairs §8.4). */
export function view(state: State): View {
  const grid = gridFor(state);
  return {
    grid: grid.id,
    columns: grid.columns,
    rows: grid.rows,
    faces: [...new Set(state.faces)].sort((a, b) => a - b),
    cards: Array.from({ length: grid.rows }, (_, row) =>
      Array.from({ length: grid.columns }, (_, column) =>
        cardView(state, row * grid.columns + column),
      ),
    ),
    turn: state.turn,
    pairs: pairsFound(state),
    out: state.out.map((out) => out?.reason ?? null),
    moves: state.moves,
    moveLimit: grid.moveLimit,
    endReason: state.endReason,
  };
}

/**
 * One line for the game list (pairs §8.5): the pairs left and whose turn it is while in progress;
 * the winner or a shared win once over. Scores are pairs found.
 */
export function summary(state: State, viewer: Seat | null): ListSummary {
  const scores = pairsFound(state);
  const final = result(state);
  if (final !== null) {
    const winners = final.ranking.filter((entry) => entry.rank === 1);
    const [winner] = winners;
    return {
      headline:
        winners.length === 1 && winner !== undefined
          ? [{ seat: winner.seat }, " won"]
          : ["Shared win"],
      scores,
    };
  }
  const left = pairsLeft(state);
  const count = `${String(left)} ${left === 1 ? "pair" : "pairs"} left · `;
  const turn = seatToAct(state);
  return {
    headline: turn === viewer ? [`${count}your turn`] : [count, { seat: turn }, " to play"],
    scores,
  };
}

/** History and notification text, from the record alone; it names no card (pairs §8.5). */
export function describe(record: PublicRecord): Text {
  const who = { seat: record.seat };
  switch (record.type) {
    case "flip":
      return [who, record.step === 1 ? " turned over a card" : " turned over a second card"];
    case "resign":
      return [who, " resigned"];
    case "timeout":
      return [who, " ran out of time"];
    case "decline":
      return [who, " declined the game"];
  }
}
