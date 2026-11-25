/**
 * Names in notification text (docs/spec/02-game-framework.md §5, 03 §7): the email nudge and the
 * push both name seated players by display name, with the same fallbacks.
 */
import { formatText } from "@your-move/sdk";
import { TextSchema } from "@your-move/shared";

import type { GamePlayerRecord, UserRecord } from "../db/repositories.js";

/** A seat whose account was deleted (02 §5, 04 §Account deletion). */
const DELETED_PLAYER = "Deleted player";
/** A display name that isn't set (04 `users.display_name`). */
const NEW_PLAYER = "New player";

/** The rows holding a seat in a started game: `playing` or `out`. */
export function seatedRows(players: readonly GamePlayerRecord[]): GamePlayerRecord[] {
  return players.filter(
    (row) => row.seat !== null && (row.state === "playing" || row.state === "out"),
  );
}

/**
 * One seated row's name: its display name, "New player" without one, "Deleted player" without a
 * user.
 */
export function playerName(
  row: GamePlayerRecord,
  users: ReadonlyMap<string, Pick<UserRecord, "displayName">>,
): string {
  const user = row.userId === null ? undefined : users.get(row.userId);
  return user === undefined ? DELETED_PLAYER : (user.displayName ?? NEW_PLAYER);
}

/** Names by seat, "You" for the recipient's seat (02 §5). Every seated row gets one. */
export function namesBySeat(
  seated: readonly GamePlayerRecord[],
  users: ReadonlyMap<string, Pick<UserRecord, "displayName">>,
  recipientSeat: number,
): string[] {
  const names: string[] = [];
  for (const row of seated) {
    if (row.seat === null) continue;
    names[row.seat] = row.seat === recipientSeat ? "You" : playerName(row, users);
  }
  return names;
}

/** A stored `describe` text (JSON) with the names filled in, or null if it can't be read. */
export function renderStoredText(stored: string, names: readonly string[]): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  const text = TextSchema.safeParse(parsed);
  return text.success ? formatText(text.data, names) : null;
}
