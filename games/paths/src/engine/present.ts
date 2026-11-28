/**
 * Presenting the game: views, list summaries and history text (docs/spec/games/paths.md §7,
 * docs/spec/02-game-framework.md §2 "Presenting", §2.1 rules 4, 5 and 9).
 *
 * Secrecy (02 §2.1 rule 4): while the game is in progress a viewer sees the board, every marker,
 * how many tiles each player holds and the deck holds, and its own hand only. The deck order is
 * never shown; once the game is over every remaining hand is.
 */
import type { ListSummary, Seat, Text } from "@your-move/sdk";

import { at } from "./at.js";
import type { PublicRecord, View } from "./schemas.js";
import { copyState, survivors, toAct, type State } from "./state.js";

/** What `viewer` may see; `null` is the public view (02 §2 `view`). */
export function view(state: State, viewer: Seat | null): View {
  const { board, markers, hands } = copyState(state);
  return {
    boardSize: state.options.boardSize,
    phase: state.phase,
    board,
    markers,
    toAct: toAct(state),
    deckCount: state.deck.length,
    handCounts: hands.map((hand) => hand.length),
    yourHand: viewer === null ? null : at(hands, viewer),
    hands: state.endReason === null ? null : hands,
    tokenHolder: state.tokenHolder,
    endReason: state.endReason,
  };
}

/**
 * One line for the game list (paths §7): "4 left of 6 · your turn" while in progress, the winner
 * or a shared win once over. Public state and whether the viewer is to act only.
 */
export function summary(state: State, viewer: Seat | null): ListSummary {
  const left = survivors(state);
  if (state.endReason !== null) {
    return {
      headline:
        state.endReason === "last-standing" ? [{ seat: at(left, 0) }, " won"] : ["Shared win"],
    };
  }
  const count = `${String(left.length)} left of ${String(state.markers.length)} · `;
  const turn = at(toAct(state), 0);
  return { headline: turn === viewer ? [count, "your turn"] : [count, { seat: turn }, " to play"] };
}

/** "A", "A and B", "A, B and C". */
function names(seats: readonly Seat[]): Text {
  return seats.flatMap((seat, i) => {
    const separator = i === 0 ? [] : [i === seats.length - 1 ? " and " : ", "];
    return [...separator, { seat }];
  });
}

/** Joins neighbouring strings, so text reads as the spec writes it (paths §7). */
function joined(parts: readonly Text[number][]): Text {
  const text: Text[number][] = [];
  for (const part of parts) {
    const last = text[text.length - 1];
    if (typeof part === "string" && typeof last === "string") text[text.length - 1] = last + part;
    else text.push(part);
  }
  return text;
}

/** History and notification text, from the record alone (02 §5, §2.1 rule 9; paths §7). */
export function describe(record: PublicRecord): Text {
  const who = { seat: record.seat };
  switch (record.type) {
    case "place-marker":
      return [who, " placed their marker"];
    case "place-tile": {
      const crashed = new Set(record.collided.flat());
      const crashes = record.eliminated.filter((seat) => crashed.has(seat));
      const offBoard = record.eliminated.filter((seat) => !crashed.has(seat));
      const text: Text[number][] = [who, " placed a tile"];
      if (crashes.length > 0) text.push(" — ", ...names(crashes), " crashed!");
      if (offBoard.length > 0) {
        text.push(crashes.length > 0 ? " " : " — ", ...names(offBoard), " ran off the board");
      }
      return joined(text);
    }
    case "resign":
      return [who, " resigned"];
    case "decline":
      return [who, " declined the game"];
    case "timeout":
      return [who, " ran out of time"];
  }
}
