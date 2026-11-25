/**
 * The new-game options form (docs/spec/02-game-framework.md §3, 07 §1.1): ruleset cards (name,
 * one-line description, key numbers, a small picture of the premium squares) and a word-list
 * select offering only the lists the chosen ruleset can be played with (words §9.3). It edits the
 * unresolved input; the server resolves and checks it (`resolveOptions`). Linking to "Upload a
 * word list" is the shell's.
 */
import type { OptionsFormProps } from "@your-move/sdk/client";
import { useState, type ReactElement } from "react";

import { catalogSchema, type Catalog } from "../engine/index.js";
import { installStyles, TOKENS } from "./styles.js";
import { plural } from "./text.js";
import { Unsupported } from "./Unsupported.js";

type CatalogRuleset = Catalog["rulesets"][number];

const FILL = {
  T: TOKENS["tw-bg"],
  D: TOKENS["dw-bg"],
  t: TOKENS["tl-bg"],
  d: TOKENS["dl-bg"],
} as const;

/** The premium layout as a small picture; the card's text carries the same facts (aria-hidden). */
function Layout({ ruleset }: { readonly ruleset: CatalogRuleset }): ReactElement {
  const n = ruleset.boardSize;
  return (
    <svg viewBox={`0 0 ${String(n)} ${String(n)}`} aria-hidden="true" focusable="false">
      <rect width={n} height={n} fill={TOKENS.cell} />
      {ruleset.premiums.flatMap((line, row) =>
        Array.from(line).map((code, col) =>
          code in FILL ? (
            <rect
              key={`${String(row)},${String(col)}`}
              x={col}
              y={row}
              width={1}
              height={1}
              fill={FILL[code as keyof typeof FILL]}
            />
          ) : null,
        ),
      )}
    </svg>
  );
}

export function OptionsForm(props: OptionsFormProps): ReactElement {
  const { catalog, value } = props;
  const [styled] = useState(installStyles);
  if (!styled) return <Unsupported />;
  const parsed = catalogSchema.safeParse(catalog);
  if (!parsed.success) return <p>The options for this game are unavailable.</p>;
  const { rulesets, dictionaries, defaults } = parsed.data;
  const input: Record<string, unknown> =
    typeof value === "object" && value !== null ? { ...value } : {};
  const chosenRuleset =
    rulesets.find((r) => r.id === input["rulesetId"])?.id ??
    rulesets.find((r) => r.id === defaults.rulesetId)?.id ??
    rulesets[0]?.id ??
    null;
  const offered = dictionaries.filter(
    (d) => chosenRuleset !== null && d.compatibleRulesets.includes(chosenRuleset),
  );
  const chosenDictionary =
    offered.find((d) => d.id === input["dictionaryId"])?.id ??
    offered.find((d) => d.id === defaults.dictionaryId)?.id ??
    offered[0]?.id ??
    "";
  const source = (kind: "builtin" | "operator" | "upload") =>
    offered.filter((d) => d.source === kind);

  return (
    <div className="ym-w ym-w-options">
      <fieldset>
        <legend>Ruleset</legend>
        {rulesets.map((ruleset) => (
          <label key={ruleset.id} className="ym-w-card">
            <input
              type="radio"
              name="words-ruleset"
              value={ruleset.id}
              checked={ruleset.id === chosenRuleset}
              onChange={() => {
                const next: Record<string, unknown> = { ...input, rulesetId: ruleset.id };
                const stillOk = dictionaries.some(
                  (d) =>
                    d.id === input["dictionaryId"] && d.compatibleRulesets.includes(ruleset.id),
                );
                if (!stillOk) delete next["dictionaryId"];
                props.onChange(next);
              }}
            />
            <Layout ruleset={ruleset} />
            <span>
              <strong>{ruleset.name}</strong>
              <br />
              {ruleset.description}
              <br />
              <span className="ym-w-meta">
                {plural(ruleset.tileCount, "tile", "tiles")} · {ruleset.bingoBonus} point bonus for
                using every tile
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <label>
        Word list{" "}
        <select
          value={chosenDictionary}
          onChange={(event) => {
            props.onChange({ ...input, dictionaryId: event.target.value });
          }}
        >
          {(["builtin", "operator"] as const).flatMap((kind) =>
            source(kind).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            )),
          )}
          {source("upload").length > 0 && (
            <optgroup label="Your uploads">
              {source("upload").map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
    </div>
  );
}
