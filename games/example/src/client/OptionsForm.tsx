/**
 * The new-game options form (docs/spec/02-game-framework.md §3): one select per option, with the
 * ranges and defaults from this module's part of the catalog. It edits the unresolved input; the
 * server resolves and checks it (`resolveOptions`).
 */
import type { OptionsFormProps } from "@your-move/sdk/client";
import type { ReactElement } from "react";

import { catalogSchema, type Catalog } from "../engine/index.js";

type Range = Catalog["handSize"];

const LABELS = { handSize: "Cards in hand", lives: "Lives" } as const;
type OptionName = keyof typeof LABELS;

export function OptionsForm(props: OptionsFormProps): ReactElement {
  const { catalog, value } = props;
  const parsed = catalogSchema.safeParse(catalog);
  if (!parsed.success) return <p>The options for this game are unavailable.</p>;
  const input: Record<string, unknown> =
    typeof value === "object" && value !== null ? { ...value } : {};

  const field = (name: OptionName, range: Range): ReactElement => {
    const current = input[name];
    const selected = typeof current === "number" ? current : range.default;
    const choices = Array.from({ length: range.max - range.min + 1 }, (_, i) => range.min + i);
    return (
      <label>
        {LABELS[name]}{" "}
        <select
          value={selected}
          onChange={(event) => {
            props.onChange({ ...input, [name]: Number(event.target.value) });
          }}
        >
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <fieldset>
      <legend>Options</legend>
      {field("handSize", parsed.data.handSize)}
      {field("lives", parsed.data.lives)}
    </fieldset>
  );
}
