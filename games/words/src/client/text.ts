/**
 * Words the board says to players: names, tiles and the answers the engine and the framework
 * give (docs/spec/games/words.md §10.3, docs/spec/05-api.md §Errors), in plain language.
 */
import type { GameEnvelope } from "@your-move/sdk";

import { BLANK } from "../engine/index.js";

/**
 * Display names by seat from the game envelope; a seat without a name is "Seat n".
 *
 * Every seat is shown by its display name alone. An AI seat must also be labelled as one (08 T31);
 * the alpha has no AI seats, so that label arrives with the AI milestone, together with the
 * `players` rows' `kind` and `aiOwnerName` this function would then read.
 */
export function seatNames(game: GameEnvelope, seats: number): string[] {
  return Array.from({ length: seats }, (_, seat) => {
    const player = game.players.find((row) => row.seat === seat);
    return player?.displayName ?? `Seat ${String(seat + 1)}`;
  });
}

/** "1 tile", "2 tiles". */
export function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** A tile as shown: its letter in capitals, `?` for a blank without a letter. */
export function shown(tile: string, letter?: string): string {
  return (letter ?? tile).toUpperCase();
}

/** A tile's spoken name. */
export function tileName(tile: string, points: number, letter?: string): string {
  if (tile === BLANK) {
    return letter === undefined ? "Blank tile" : `Blank tile standing for ${shown(tile, letter)}`;
  }
  return `${shown(tile)}, ${plural(points, "point", "points")}`;
}

const PLACEMENT_TEXT: Readonly<Record<string, string>> = {
  NOT_IN_LINE: "Tiles must all be in one row or one column.",
  GAP: "There is a gap between your tiles.",
  NOT_CONNECTED: "Your play must touch a tile already on the board.",
  START_NOT_COVERED: "The first play must cover the start square.",
  TOO_FEW_TILES: "The first play needs at least two tiles.",
  TOO_MANY_TILES: "That is more tiles than your rack holds.",
  SQUARE_OCCUPIED: "That square is already taken.",
  TILE_NOT_IN_RACK: "That tile isn't on your rack any more.",
  BLANK_NEEDS_LETTER: "Choose a letter for the blank.",
};

/** What a placement error's `detail` says, in words. */
function placementText(detail: unknown): string {
  return (
    (typeof detail === "string" ? PLACEMENT_TEXT[detail] : undefined) ??
    "Those tiles can't be played there."
  );
}

/** The words a refused play names, in capitals. */
function wordsIn(detail: unknown): string[] {
  if (typeof detail !== "object" || detail === null || !("words" in detail)) return [];
  const { words } = detail;
  return Array.isArray(words)
    ? words.filter((word): word is string => typeof word === "string").map((w) => w.toUpperCase())
    : [];
}

/** A short explanation of an error from `preview` or `submit`, for the player. */
export function errorText(error: { readonly code: string; readonly detail?: unknown }): string {
  switch (error.code) {
    case "INVALID_PLACEMENT":
      return placementText(error.detail);
    case "INVALID_WORDS": {
      const words = wordsIn(error.detail);
      return words.length > 0
        ? `Not in the word list: ${words.join(", ")}.`
        : "Not in the word list.";
    }
    case "SWAP_NOT_ALLOWED":
      return error.detail === "BAG_TOO_SMALL"
        ? "There are too few tiles in the bag to swap."
        : "Those tiles can't be swapped.";
    case "NOT_TO_ACT":
    case "NOT_YOUR_TURN":
      return "It isn't your turn.";
    case "STALE_GAME":
      return "The game moved on while you were choosing. Your tiles are kept; the board is refreshing.";
    case "GAME_NOT_ACTIVE":
      return "This game is over.";
    case "RATE_LIMITED":
      return "Too many requests. Wait a moment and try again.";
    default:
      return `That couldn't be done (${error.code}).`;
  }
}
