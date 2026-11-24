/**
 * The rules sheet (docs/spec/02-game-framework.md §3, §7.2): the manifest's rules for the game's
 * rules version, as plain React text. The Markdown is read only for its block structure
 * (headings, bullet lists, paragraphs); nothing is ever rendered as HTML.
 */
import type { RulesSheetProps } from "@your-move/sdk/client";
import type { ReactElement } from "react";

import type { Options } from "../engine/index.js";
import { manifest } from "../manifest.js";
import { plural } from "./names.js";

type Block =
  | { kind: "heading"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "paragraph"; text: string };

/** Splits rules Markdown into headings, bullet lists and paragraphs. */
function blocks(markdown: string): Block[] {
  const result: Block[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    const last = result.at(-1);
    if (line === "") {
      result.push({ kind: "paragraph", text: "" });
    } else if (line.startsWith("#")) {
      result.push({ kind: "heading", text: line.replace(/^#+\s*/u, "") });
    } else if (line.startsWith("- ")) {
      if (last?.kind === "list") last.items.push(line.slice(2));
      else result.push({ kind: "list", items: [line.slice(2)] });
    } else if (last?.kind === "paragraph") {
      last.text = last.text === "" ? line : `${last.text} ${line}`;
    } else {
      result.push({ kind: "paragraph", text: line });
    }
  }
  return result.filter((block) => block.kind !== "paragraph" || block.text !== "");
}

export function RulesSheet({ options, gameVersion }: RulesSheetProps<Options>): ReactElement {
  const rules = manifest.rules[gameVersion];
  return (
    <article aria-label="Rules">
      <p>
        This game: {plural(options.handSize, "card", "cards")} in hand,{" "}
        {plural(options.lives, "life", "lives")}.
      </p>
      {rules === undefined ? (
        <p>The rules for this version are unavailable.</p>
      ) : (
        blocks(rules).map((block, index) => {
          switch (block.kind) {
            case "heading":
              return <h3 key={index}>{block.text}</h3>;
            case "list":
              return (
                <ul key={index}>
                  {block.items.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              );
            case "paragraph":
              return <p key={index}>{block.text}</p>;
          }
        })
      )}
    </article>
  );
}
