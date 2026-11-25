/**
 * The rules sheet (docs/spec/02-game-framework.md §3, §7.2): this game's ruleset in numbers, then
 * the manifest's rules for the game's rules version as plain React text. The Markdown is read only
 * for its block structure (headings, bullet lists, paragraphs); nothing is ever rendered as HTML.
 */
import type { RulesSheetProps } from "@your-move/sdk/client";
import type { ReactElement } from "react";

import { findRuleset, totalTiles, type Options } from "../engine/index.js";
import { manifest } from "../manifest.js";
import { plural } from "./text.js";

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
      const item = line.slice(2);
      if (last?.kind === "list") last.items.push(item);
      else result.push({ kind: "list", items: [item] });
    } else if (last?.kind === "paragraph") {
      last.text = last.text === "" ? line : `${last.text} ${line}`;
    } else {
      result.push({ kind: "paragraph", text: line });
    }
  }
  return result.filter((block) => block.kind !== "paragraph" || block.text !== "");
}

/** Text with `**bold**` runs as `<strong>`; nothing else in the Markdown is interpreted. */
function inline(text: string): ReactElement[] {
  return text
    .split("**")
    .map((part, index) =>
      index % 2 === 1 ? <strong key={index}>{part}</strong> : <span key={index}>{part}</span>,
    );
}

export function RulesSheet({ options, gameVersion }: RulesSheetProps<Options>): ReactElement {
  const rules = manifest.rules[gameVersion];
  const ruleset = findRuleset(options.rulesetId, options.rulesetVersion);
  return (
    <article aria-label="Rules" className="ym-w-rules">
      {ruleset !== undefined && (
        <p>
          This game: the {ruleset.name} ruleset, {plural(totalTiles(ruleset), "tile", "tiles")} in
          all, racks of {String(ruleset.rackSize)}, {String(ruleset.bingoBonus)} points for using
          every tile, swaps while the bag holds at least {String(ruleset.swapMinBag)}. Word list:{" "}
          {options.dictionaryId}.
        </p>
      )}
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
                    <li key={i}>{inline(item)}</li>
                  ))}
                </ul>
              );
            case "paragraph":
              return <p key={index}>{inline(block.text)}</p>;
          }
        })
      )}
    </article>
  );
}
