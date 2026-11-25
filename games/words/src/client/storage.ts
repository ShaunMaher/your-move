/**
 * The one thing the board keeps in the browser: the order the player arranged their rack in, as
 * a permutation of positions in the (sorted) rack, never the letters. The shell wipes every key
 * under `ym.game.` at sign-out and logout-all (02 §3, 06 §4), so the key is
 * `ym.game.<gameType>.<userId>.<gameId>`: per user and game, never shared between accounts on one
 * device. Everything is best effort: storage may be blocked, full or missing.
 */
import type { GameEnvelope } from "@your-move/sdk";

/** The key for this viewer's rack order in this game, or null when the viewer has no user id. */
export function rackOrderKey(game: GameEnvelope): string | null {
  const userId =
    game.yourSeat === null
      ? null
      : game.players.find((player) => player.seat === game.yourSeat)?.userId;
  return userId == null ? null : `ym.game.${game.gameType}.${userId}.${game.id}`;
}

/** A saved order, if it is a permutation of `0..size-1`; anything else is ignored. */
export function loadOrder(key: string | null, size: number): number[] | null {
  if (key === null) return null;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!Array.isArray(parsed) || parsed.length !== size) return null;
    const seen = new Set<unknown>(parsed);
    const valid =
      seen.size === size &&
      parsed.every((id) => Number.isInteger(id) && (id as number) >= 0 && (id as number) < size);
    return valid ? (parsed as number[]) : null;
  } catch {
    return null;
  }
}

export function saveOrder(key: string | null, order: readonly number[]): void {
  if (key === null) return;
  try {
    localStorage.setItem(key, JSON.stringify(order));
  } catch {
    // Best effort: the order is a convenience (07 §2).
  }
}

export function clearOrder(key: string | null): void {
  if (key === null) return;
  try {
    localStorage.removeItem(key);
  } catch {
    // Best effort.
  }
}
