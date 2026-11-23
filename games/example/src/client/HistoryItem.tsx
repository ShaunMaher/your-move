/**
 * One history entry (docs/spec/02-game-framework.md §3, §5), rendered from its public record with
 * the engine's own `describe`, so the text matches what notifications said.
 */
import { formatText, type HistoryItemProps } from "@your-move/sdk/client";
import type { ReactElement } from "react";

import { engines, recordSchema } from "../engine/index.js";

/**
 * Renders a record this client understands; for anything else (an unknown rules version or record
 * shape) it falls back to the entry's stored `describe` text (02 §3).
 */
export function HistoryItem({
  record,
  describe,
  gameVersion,
  names,
}: HistoryItemProps): ReactElement {
  const parsed = recordSchema.safeParse(record);
  const text =
    gameVersion === engines[1].version && parsed.success
      ? engines[1].describe(parsed.data)
      : describe;
  return <span>{formatText(text, names)}</span>;
}
