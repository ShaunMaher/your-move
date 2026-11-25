/** Names and labels for the game screens (02 §5: names are filled in when shown; "You" for yourself). */
import { formatText } from "@your-move/sdk/client";

import type { GameSummary, Player } from "./game-api.js";

type Text = Parameters<typeof formatText>[0];

/** A seat whose account was deleted (02 §5, 04 §Account deletion). */
const DELETED_PLAYER = "Deleted player";
/** A display name that isn't set (04 `users.display_name`). */
const NEW_PLAYER = "New player";

/**
 * A player's name as the shell shows it: "You" for the viewer, else the display name. Without one,
 * a member whose `userId` is gone is a deleted account and any other member has no name yet; a row
 * that never joined has no name or id for anyone (05 §Who sees what), so it is just "A player".
 */
export function seatLabel(player: Player): string {
  if (player.isYou) return "You";
  if (player.displayName !== null) return player.displayName;
  if (player.state !== "joined" && player.state !== "playing" && player.state !== "out")
    return "A player";
  return player.userId === null ? DELETED_PLAYER : NEW_PLAYER;
}

/** Names by seat number, for `Text` placeholders and the module's history items. */
export function namesBySeat(players: readonly Player[]): string[] {
  const seats = Math.max(0, ...players.map((player) => (player.seat ?? -1) + 1));
  return Array.from({ length: seats }, (_, seat) => {
    const player = players.find((row) => row.seat === seat);
    return player === undefined ? "A player" : seatLabel(player);
  });
}

export function textOf(text: Text, players: readonly Player[]): string {
  return formatText(text, namesBySeat(players));
}

/** The other people in a game, for a list row: "Sam", "Sam and Alex". */
export function opponentNames(players: readonly Player[]): string {
  const others = players
    .filter((player) => !player.isYou && player.state !== "declined" && player.state !== "removed")
    .map((player) => player.displayName ?? player.invitedAs ?? "Invited player");
  if (others.length === 0) return "No one yet";
  if (others.length === 1) return others[0] ?? "";
  return `${others.slice(0, -1).join(", ")} and ${others.at(-1) ?? ""}`;
}

export type Section = "your-turn" | "invitations" | "waiting" | "finished";

/** Which list section a game belongs in (07 §1). */
export function sectionOf(
  game: Pick<GameSummary, "status" | "yourTurn" | "yourInvitation">,
): Section {
  if (game.yourInvitation !== null && game.status === "lobby") return "invitations";
  if (game.status === "active") return game.yourTurn ? "your-turn" : "waiting";
  if (game.status === "lobby") return "waiting";
  return "finished";
}

const END_REASONS: Readonly<Record<string, string>> = {
  declined: "Declined, no result",
  cancelled: "Cancelled",
  expired: "Expired",
  resign: "Resigned",
  resigned: "Resigned",
  timeout: "Ran out of time",
};

/** Why a finished game ended, in words; empty when the module's own text says it. */
export function endReasonText(endReason: string | null, status: string): string {
  if (endReason !== null && Object.hasOwn(END_REASONS, endReason))
    return END_REASONS[endReason] ?? "";
  return END_REASONS[status] ?? "";
}
