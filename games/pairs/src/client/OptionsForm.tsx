/**
 * The new-game options form (docs/spec/02-game-framework.md §3, 07 §1.1, pairs §7, §9): the grid
 * as radios. It edits the unresolved input; the server resolves and checks it (`resolveOptions`).
 */
import type { OptionsFormProps } from "@your-move/sdk/client";
import { useState, type ReactElement } from "react";

import { catalogSchema } from "../engine/index.js";
import { installStyles } from "./styles.js";
import { Unsupported } from "./Unsupported.js";

/** What each grid is for, beside its size and pairs; the usual one says so instead. */
const NOTE: Readonly<Record<string, string>> = { "4x4": ", quickest", "6x6": ", longest" };

export function OptionsForm(props: OptionsFormProps): ReactElement {
  const { catalog, value } = props;
  const [styled] = useState(installStyles);
  if (!styled) return <Unsupported />;
  const parsed = catalogSchema.safeParse(catalog);
  if (!parsed.success) return <p>The options for this game are unavailable.</p>;
  const { grid, grids } = parsed.data;
  const input: Record<string, unknown> =
    typeof value === "object" && value !== null ? { ...value } : {};
  const chosen =
    typeof input["grid"] === "string" && grid.values.some((id) => id === input["grid"])
      ? input["grid"]
      : grid.default;

  return (
    <div className="ym-pr ym-pr-options">
      <fieldset>
        <legend>Grid</legend>
        {grids.map((entry) => (
          <label key={entry.id} className="ym-pr-choice">
            <input
              type="radio"
              name="pairs-grid"
              value={entry.id}
              checked={entry.id === chosen}
              onChange={() => {
                props.onChange({ ...input, grid: entry.id });
              }}
            />
            <span>
              <strong>{`${String(entry.columns)} × ${String(entry.rows)}`}</strong>
              {`: ${String(entry.pairs)} pairs${entry.id === grid.default ? " (usual)" : (NOTE[entry.id] ?? "")}`}
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
