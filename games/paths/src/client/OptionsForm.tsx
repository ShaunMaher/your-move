/**
 * The new-game options form (docs/spec/02-game-framework.md §3, 07 §1.1, paths §6): how many
 * tiles each player holds and whether you may run your own marker off the board when another
 * choice avoids it. It edits the unresolved input; the server resolves and checks it
 * (`resolveOptions`). The board is always 6 × 6 in rules version 1, so it isn't offered.
 */
import type { OptionsFormProps } from "@your-move/sdk/client";
import { useState, type ReactElement } from "react";

import { catalogSchema } from "../engine/index.js";
import { installStyles } from "./styles.js";
import { Unsupported } from "./Unsupported.js";

const SELF_ELIMINATION_TEXT = {
  avoidIfPossible: {
    name: "Protect your marker",
    detail:
      "You can't run your own marker off the board if any tile and turn in your hand avoids it.",
  },
  allowed: {
    name: "Anything goes",
    detail: "You may place any tile in any turn, even one that runs your marker off the board.",
  },
} as const;

export function OptionsForm(props: OptionsFormProps): ReactElement {
  const { catalog, value } = props;
  const [styled] = useState(installStyles);
  if (!styled) return <Unsupported />;
  const parsed = catalogSchema.safeParse(catalog);
  if (!parsed.success) return <p>The options for this game are unavailable.</p>;
  const { handSize, selfElimination } = parsed.data;
  const input: Record<string, unknown> =
    typeof value === "object" && value !== null ? { ...value } : {};
  const chosenHand = typeof input["handSize"] === "number" ? input["handSize"] : handSize.default;
  const chosenRule =
    typeof input["selfElimination"] === "string" &&
    selfElimination.values.some((rule) => rule === input["selfElimination"])
      ? input["selfElimination"]
      : selfElimination.default;
  const sizes = Array.from({ length: handSize.max - handSize.min + 1 }, (_, i) => handSize.min + i);

  return (
    <div className="ym-p ym-p-options">
      <fieldset>
        <legend>Tiles in each hand</legend>
        {sizes.map((size) => (
          <label key={size} className="ym-p-card">
            <input
              type="radio"
              name="paths-hand-size"
              value={size}
              checked={size === chosenHand}
              onChange={() => {
                props.onChange({ ...input, handSize: size });
              }}
            />
            <span>
              <strong>{size === 1 ? "1 tile" : `${String(size)} tiles`}</strong>
              {size === handSize.default ? " (usual)" : ""}
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Running your own marker off the board</legend>
        {selfElimination.values.map((rule) => (
          <label key={rule} className="ym-p-card">
            <input
              type="radio"
              name="paths-self-elimination"
              value={rule}
              checked={rule === chosenRule}
              onChange={() => {
                props.onChange({ ...input, selfElimination: rule });
              }}
            />
            <span>
              <strong>{SELF_ELIMINATION_TEXT[rule].name}</strong>
              {rule === selfElimination.default ? " (usual)" : ""}
              <br />
              {SELF_ELIMINATION_TEXT[rule].detail}
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
