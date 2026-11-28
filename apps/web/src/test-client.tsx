/** A fake game client module for the shell's component tests: it records how the shell drives it. */
import type {
  BoardProps,
  GameClientModule,
  HistoryItemProps,
  OptionsFormProps,
  RulesSheetProps,
} from "@your-move/sdk/client";
import { useState } from "react";

export const submitted: unknown[] = [];
/** The `resources` prop of every render of the board, in order. */
export const boardResources: unknown[] = [];

function OptionsForm({ catalog, value, onChange }: OptionsFormProps) {
  return (
    <div>
      <p>Options form: {JSON.stringify(catalog)}</p>
      <p>Value: {JSON.stringify(value)}</p>
      <button
        type="button"
        onClick={() => {
          onChange({ rulesetId: "casual" });
        }}
      >
        Pick casual
      </button>
    </div>
  );
}

function Board({ game, view, submit, preview, resources }: BoardProps<unknown, unknown, unknown>) {
  const [text, setText] = useState("");
  boardResources.push(resources);
  const list = resources?.dictionary;
  return (
    <section aria-label="Fake board">
      <p>
        Board v{String(game.version)}: {JSON.stringify(view)}
      </p>
      <p>
        Word list:{" "}
        {list === undefined
          ? "none"
          : `${list.id} v${String(list.version)}, ab ${String(list.has("ab"))}`}
      </p>
      <button
        type="button"
        onClick={() => {
          submitted.push("play");
          void submit({ type: "play" }).then(
            (result) => {
              setText(result.ok ? "sent" : `refused ${result.error.code}`);
            },
            () => {
              setText("lost");
            },
          );
        }}
      >
        Play
      </button>
      <button
        type="button"
        onClick={() => {
          void preview({ type: "play" }).then(
            (result) => {
              setText(`preview ${JSON.stringify(result)}`);
            },
            () => {
              setText("preview lost");
            },
          );
        }}
      >
        Check
      </button>
      <p role="status">{text}</p>
    </section>
  );
}

function RulesSheet({ options, gameVersion }: RulesSheetProps<unknown>) {
  return (
    <p>
      Rules for v{String(gameVersion)} {JSON.stringify(options)}
    </p>
  );
}

function HistoryItem({ record, describe, names }: HistoryItemProps) {
  const text = describe
    .map((part) => (typeof part === "string" ? part : (names[part.seat] ?? "?")))
    .join("");
  return (
    <span>
      {JSON.stringify(record)} / {text}
    </span>
  );
}

export const fakeClient: GameClientModule = {
  type: "words",
  versions: [1],
  OptionsForm,
  Board,
  RulesSheet,
  HistoryItem,
};
