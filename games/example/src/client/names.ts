import type { GameEnvelope } from "@your-move/sdk";

/**
 * Display names by seat from the game envelope (05 §Common types); a seat without a name shows as
 * "Seat n", numbered from 1, as `formatText` does.
 */
export function seatNames(game: GameEnvelope, seats: number): string[] {
  return Array.from({ length: seats }, (_, seat) => {
    const player = game.players.find((row) => row.seat === seat);
    return player?.displayName ?? `Seat ${String(seat + 1)}`;
  });
}

/** "1 life", "2 lives". */
export function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}
