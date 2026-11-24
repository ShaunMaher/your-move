/**
 * Presenting the game: views, list summaries and history text (docs/spec/02-game-framework.md §2
 * "Presenting", §2.1 rules 4, 5 and 9).
 *
 * Secrecy (02 §2.1 rule 4): while the game is in progress a viewer sees its own hand and its own
 * secret play, and of everyone else only what is public: counts, lives, points, *whether* a seat
 * has played this round (never which card), and the last round once it was revealed. The deck
 * order and the face-down discards are never shown. Once the game is over every hand is revealed.
 */
import type { ListSummary, Seat, Text } from "@your-move/sdk";

import { at } from "./at.js";
import type { PublicRecord, View } from "./schemas.js";
import { playingSeats, toAct, type State } from "./state.js";

/** What `viewer` may see; `null` is the public view (02 §2 `view`). */
export function view(state: State, viewer: Seat | null): View {
  const over = state.endReason !== null;
  return {
    round: state.round,
    deckCount: state.deck.length,
    you: viewer,
    yourPlay: viewer === null ? null : at(state.pending, viewer),
    seats: state.status.map((status, seat) => ({
      status,
      lives: at(state.lives, seat),
      points: at(state.points, seat),
      handCount: at(state.hands, seat).length,
      played: state.pending[seat] !== null,
      hand: over || seat === viewer ? [...at(state.hands, seat)] : null,
    })),
    lastRound: state.lastRound && {
      ...state.lastRound,
      plays: state.lastRound.plays.map((play) => ({ ...play })),
    },
    endReason: state.endReason,
  };
}

/**
 * One line for the game list (02 §2 `summary`), with every seat's points. It depends only on
 * public state and on whether the viewer is to act.
 */
export function summary(state: State, viewer: Seat | null): ListSummary {
  const scores = [...state.points];
  if (state.endReason !== null) {
    const leaders = playingSeats(state);
    const headline: Text =
      leaders.length === 1 ? [{ seat: at(leaders, 0) }, " won"] : ["Game over: out of cards"];
    return { headline, scores };
  }
  const waiting = toAct(state);
  const round = `Round ${String(state.round)}: `;
  if (viewer !== null && waiting.includes(viewer))
    return { headline: [round, "your turn"], scores };
  const noun = waiting.length === 1 ? "player" : "players";
  return { headline: [round, `waiting for ${String(waiting.length)} ${noun}`], scores };
}

/** History and notification text, from the record alone (02 §5, §2.1 rule 9). */
export function describe(record: PublicRecord): Text {
  const who = { seat: record.seat };
  switch (record.kind) {
    case "played":
      return [who, ` played a card in round ${String(record.round)}`];
    case "resigned":
      return [who, " resigned"];
    case "declined":
      return [who, " declined the game"];
    case "timedOut":
      return [who, " ran out of time"];
  }
}
