/**
 * Words the board says to players: names, the status line, the accessible names of the cards
 * (docs/spec/games/pairs.md §9) and the answers the engine and the framework give, in plain
 * language. Every function here takes only what the current view shows: a face is named only for
 * a card the view gives a face, so no text outlives the view that justified it.
 */
import type { GameEnvelope, Seat } from "@your-move/sdk";

import { FACES, type Card, type View } from "../engine/index.js";

/**
 * Display names by seat from the game envelope; a seat without a name is "Seat n". Seats that
 * share a display name get their number added ("Ann (player 2)"), so no line says only "Ann"
 * for two people (pairs §9).
 */
export function seatNames(game: GameEnvelope, seats: number): string[] {
  return distinct(
    Array.from({ length: seats }, (_, seat) => {
      const player = game.players.find((row) => row.seat === seat);
      return player?.displayName ?? `Seat ${String(seat + 1)}`;
    }),
  );
}

/** People may share a display name (a join link takes anyone): the player number tells them apart. */
export function distinct(names: readonly string[]): string[] {
  return names.map((name, seat) =>
    names.filter((other) => other === name).length > 1
      ? `${name} (player ${String(seat + 1)})`
      : name,
  );
}

/** "1 pair", "2 pairs". */
export function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** The face's name, `"star"`; an id outside the faces reads as "card". */
function faceName(face: number): string {
  return FACES[face]?.name ?? "card";
}

/** The face's plural, `"stars"`. */
function facePlural(face: number): string {
  return FACES[face]?.plural ?? "cards";
}

/** "row 2, column 3", from 0-based indexes. */
function where(row: number, column: number): string {
  return `row ${String(row + 1)}, column ${String(column + 1)}`;
}

/** How the board talks about the game: under way, ended by a rule, or stopped without one. */
export type Mode = "play" | "over" | "stopped";

/** What a name needs to know about the viewer. */
export interface Who {
  readonly names: readonly string[];
  readonly you: Seat | null;
}

/** "your" or "Sam's". */
function possessive(who: Who, seat: Seat): string {
  return seat === who.you ? "your" : `${who.names[seat] ?? "Someone"}'s`;
}

/**
 * A card's accessible name, rows and columns from 1 (pairs §9): "Row 2, column 3, face down";
 * "Row 2, column 3, star, your first card"; "Row 2, column 3, star, Sam's first card"; "Row 1,
 * column 2, moon, Sam's last turn, turns face down at the next first card"; "Row 4, column 4,
 * apple, matched by Ann". A stopped game drops the in-play hints ("... Sam's first card when the
 * game stopped"); a finished one names the faces left down "not found".
 */
export function cardName(row: number, column: number, card: Card, who: Who, mode: Mode): string {
  const place = `Row ${String(row + 1)}, column ${String(column + 1)}`;
  switch (card.state) {
    case "down":
      return card.face === null
        ? `${place}, face down`
        : `${place}, ${faceName(card.face)}, not found`;
    case "up":
      return `${place}, ${faceName(card.face)}, ${possessive(who, card.by)} first card${
        mode === "stopped" ? " when the game stopped" : ""
      }`;
    case "missed":
      return `${place}, ${faceName(card.face)}, ${possessive(who, card.by)} last turn${
        mode === "play" ? ", turns face down at the next first card" : ""
      }`;
    case "matched":
      return `${place}, ${faceName(card.face)}, matched by ${
        card.by === who.you ? "you" : (who.names[card.by] ?? "someone")
      }`;
  }
}

/** A card the view shows face up, with its place. */
interface Shown {
  readonly row: number;
  readonly column: number;
  readonly card: Exclude<Card, { state: "down" }>;
}

/** The cards of the view in `state`, in reading order. */
function cardsIn(view: View, state: Shown["card"]["state"]): Shown[] {
  const found: Shown[] = [];
  view.cards.forEach((cards, row) => {
    cards.forEach((card, column) => {
      if (card.state !== "down" && card.state === state) found.push({ row, column, card });
    });
  });
  return found;
}

/** The cards named for the status line: "moon (row 1, column 2) and key (row 3, column 4)". */
function describeShown(shown: readonly Shown[]): string {
  return shown
    .map(({ row, column, card }) => `${faceName(card.face)} (${where(row, column)})`)
    .join(" and ");
}

/** A short explanation of an error from `submit`, for the player. */
export function errorText(error: { readonly code: string; readonly detail?: unknown }): string {
  switch (error.code) {
    case "NOT_TO_ACT":
    case "NOT_YOUR_TURN":
      return "It isn't your turn.";
    case "CARD_FACE_UP":
      return "That card is already face up. Pick another.";
    case "OUT_OF_RANGE":
      return "That card isn't on the board. The board is refreshing.";
    case "STALE_GAME":
      return "The game moved on while you were choosing. The board is refreshing.";
    case "GAME_NOT_ACTIVE":
      return "This game is over.";
    case "RATE_LIMITED":
      return "Too many requests. Wait a moment and try again.";
    default:
      return `That couldn't be done (${error.code}).`;
  }
}

/** "a star", "an apple". */
function withArticle(name: string): string {
  return `${/^[aeiou]/u.test(name) ? "an" : "a"} ${name}`;
}

/** `Your` or `Sam's`, as a sentence starts. */
function startOf(who: Who, seat: Seat): string {
  return seat === who.you ? "Your" : possessive(who, seat);
}

/**
 * What the view shows right now, as a sentence for the status line (pairs §9), or null when it
 * shows nothing to say: the turn's first card, or the previous turn's missed pair (with the
 * reminder that it goes down at the next first card when it is the viewer's turn). It names only
 * faces the view gives a face to.
 */
export function shownLine(view: View, who: Who, mode: Mode, yourTurn: boolean): string | null {
  if (mode !== "play") return null;
  const [up] = cardsIn(view, "up");
  if (up !== undefined) {
    const by = up.card.by === who.you ? "You" : (who.names[up.card.by] ?? "Someone");
    return `${by} turned over ${withArticle(faceName(up.card.face))} (${where(up.row, up.column)}).`;
  }
  const missed = cardsIn(view, "missed");
  const [first] = missed;
  if (first !== undefined) {
    const line = `${startOf(who, first.card.by)} last turn: ${describeShown(missed)}.`;
    return yourTurn ? `${line} They turn face down when you turn your first card.` : line;
  }
  if (!yourTurn && view.turn !== null) return `${who.names[view.turn] ?? "Someone"} to play.`;
  return null;
}

/**
 * What the viewer's own second card did, as the new view shows it (pairs §9): "A pair of stars!
 * Your turn again." or "No match. Sam to play."; null for any other change of view.
 */
export function moveNote(before: View, after: View, who: Who): string | null {
  const me = who.you;
  if (me === null || !cardsIn(before, "up").some(({ card }) => card.by === me)) return null;
  const was = new Set(
    cardsIn(before, "matched").map(({ row, column }) => `${String(row)}:${String(column)}`),
  );
  const found = cardsIn(after, "matched").filter(
    ({ row, column, card }) => card.by === me && !was.has(`${String(row)}:${String(column)}`),
  );
  const [pair] = found;
  if (found.length === 2 && pair !== undefined) {
    const stars = `A pair of ${facePlural(pair.card.face)}!`;
    return after.endReason === null ? `${stars} Your turn again.` : stars;
  }
  if (after.turn !== null && cardsIn(after, "missed").some(({ card }) => card.by === me)) {
    return `No match. ${who.names[after.turn] ?? "Someone"} to play.`;
  }
  return null;
}

/** How the game ended, in the board's own words (pairs §9); null for a game stopped without a rule. */
export function endingLine(view: View, names: readonly string[]): string | null {
  switch (view.endReason) {
    case "all-found":
      return "All the pairs were found.";
    case "last-standing": {
      const last = view.out.findIndex((out) => out === null);
      return `Only ${names[last] ?? "one player"} was left playing.`;
    }
    case "move-limit": {
      const found = view.pairs.reduce((sum, count) => sum + count, 0);
      return `The move limit (${String(view.moveLimit)} moves) was reached with ${plural(
        view.faces.length - found,
        "pair",
        "pairs",
      )} still face down.`;
    }
    case null:
      return null;
  }
}
