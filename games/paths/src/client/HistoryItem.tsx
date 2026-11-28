/**
 * One history entry (docs/spec/02-game-framework.md §3, §5): the engine's own `describe` of the
 * public record, so the text matches what notifications said. A record this client doesn't
 * understand falls back to the stored text.
 */
import { formatText, type HistoryItemProps } from "@your-move/sdk/client";
import type { ReactElement } from "react";

import { engines, recordSchema } from "../engine/index.js";
import { distinct } from "./text.js";

export function HistoryItem({
  record,
  describe,
  gameVersion,
  names,
}: HistoryItemProps): ReactElement {
  const parsed = recordSchema.safeParse(record);
  const shown = distinct(names);
  if (gameVersion !== engines[1].version || !parsed.success) {
    return <span>{formatText(describe, shown)}</span>;
  }
  return <span>{formatText(engines[1].describe(parsed.data), shown)}</span>;
}
