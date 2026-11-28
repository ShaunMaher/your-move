/**
 * Words the board says to players: names, the answers the engine and the framework give
 * (docs/spec/games/paths.md §7, docs/spec/05-api.md §Errors) and the accessible names of the
 * board's parts (paths §8), in plain language.
 */
import type { GameEnvelope } from "@your-move/sdk";

import { notchName } from "./layout.js";

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

/** "A", "A and B", "A, B and C". */
export function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

/** The name of a square: "Row 2, column 5, empty, your marker faces this square" (paths §8). */
export function squareName(
  r: number,
  c: number,
  state: { tile: boolean; facing: readonly string[]; youFace: boolean },
): string {
  const parts = [`Row ${String(r + 1)}`, `column ${String(c + 1)}`];
  parts.push(state.tile ? "tile placed" : "empty");
  if (state.youFace) parts.push("your marker faces this square");
  for (const name of state.facing) parts.push(`${name}'s marker faces this square`);
  return parts.join(", ");
}

/** The name of an edge notch button: "Top edge, left notch, free" (paths §8). */
export function notchButtonName(n: number, free: boolean): string {
  return `${notchName(n)}, ${free ? "free" : "occupied"}`;
}

/** The name of a hand tile: "Tile 3 of 3, rotated 90 degrees; your marker would survive" (paths §8). */
export function handTileName(
  index: number,
  count: number,
  rotation: number,
  eliminates: boolean | null,
): string {
  const base = `Tile ${String(index + 1)} of ${String(count)}, rotated ${String(rotation * 90)} degrees`;
  if (eliminates === null) return base;
  return `${base}; your marker would ${eliminates ? "be eliminated" : "survive"}`;
}

/** A short explanation of an error from `submit`, for the player. */
export function errorText(error: { readonly code: string; readonly detail?: unknown }): string {
  switch (error.code) {
    case "SELF_ELIMINATION_AVOIDABLE":
      return "Another tile or turn keeps your marker on the board, so you can't play this one.";
    case "NOTCH_OCCUPIED":
      return "Another marker is already on that notch. Pick a different one.";
    case "NOT_IN_HAND":
      return "That tile isn't in your hand any more. The board is refreshing.";
    case "NOT_TO_ACT":
    case "NOT_YOUR_TURN":
    case "WRONG_PHASE":
      return "It isn't your turn.";
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
