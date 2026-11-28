/** Display text helpers (docs/spec/02-game-framework.md §5), shared by clients and the server. */
import type { Text } from "./contract.js";

/**
 * Fills a `Text`'s seat placeholders with names (02 §5). A seat without a name renders as
 * "Seat n" (numbered from 1).
 *
 * @public
 */
export function formatText(text: Text, names: readonly string[]): string {
  return text
    .map((part) =>
      typeof part === "string" ? part : (names[part.seat] ?? `Seat ${String(part.seat + 1)}`),
    )
    .join("");
}
