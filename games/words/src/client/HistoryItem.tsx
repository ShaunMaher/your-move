/**
 * One history entry (docs/spec/02-game-framework.md §3, §5): the engine's own `describe` of the
 * public record, so the text matches what notifications said, and for a play the words it formed
 * with their scores. A record this client doesn't understand falls back to the stored text.
 */
import { formatText, type HistoryItemProps } from "@your-move/sdk/client";
import type { ReactElement } from "react";

import { engines, recordSchema } from "../engine/index.js";

export function HistoryItem({
  record,
  describe,
  gameVersion,
  names,
}: HistoryItemProps): ReactElement {
  const parsed = recordSchema.safeParse(record);
  if (gameVersion !== engines[1].version || !parsed.success) {
    return <span>{formatText(describe, names)}</span>;
  }
  const { data } = parsed;
  return (
    <span>
      {formatText(engines[1].describe(data), names)}
      {data.type === "play" && (
        <span className="ym-w-detail">
          {" ("}
          {data.words.map((w) => `${w.word.toUpperCase()} ${String(w.score)}`).join(", ")}
          {")"}
        </span>
      )}
    </span>
  );
}
