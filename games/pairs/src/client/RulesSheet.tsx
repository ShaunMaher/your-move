/**
 * The rules sheet (docs/spec/02-game-framework.md §3, §7.2; pairs §9): this game's options in
 * words, then the manifest's rules for the game's rules version as plain React text. The Markdown
 * is read only for its block structure (headings, bulleted and numbered lists with one level of
 * sub-items, paragraphs); nothing is ever rendered as HTML.
 */
import type { RulesSheetProps } from "@your-move/sdk/client";
import { useState, type ReactElement } from "react";

import { GRIDS, type Options } from "../engine/index.js";
import { manifest } from "../manifest.js";
import { installStyles } from "./styles.js";

interface Item {
  readonly text: string;
  readonly subs: string[];
}

type Block =
  | { kind: "heading"; text: string }
  | { kind: "list"; ordered: boolean; items: Item[] }
  | { kind: "paragraph"; text: string };

const ITEM = /^(\s*)(?:(-)|\d+\.)\s+(.*)$/u;

/** Splits rules Markdown into headings, lists (one level of sub-items) and paragraphs. */
function blocks(markdown: string): Block[] {
  const result: Block[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    const last = result.at(-1);
    const item = ITEM.exec(raw);
    if (line === "") {
      result.push({ kind: "paragraph", text: "" });
    } else if (line.startsWith("#")) {
      result.push({ kind: "heading", text: line.replace(/^#+\s*/u, "") });
    } else if (item !== null) {
      const text = item[3] ?? "";
      const nested = (item[1] ?? "").length > 0;
      if (nested && last?.kind === "list") last.items.at(-1)?.subs.push(text);
      else if (last?.kind === "list" && last.ordered === (item[2] === undefined)) {
        last.items.push({ text, subs: [] });
      } else {
        result.push({ kind: "list", ordered: item[2] === undefined, items: [{ text, subs: [] }] });
      }
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
  useState(installStyles);
  const rules = manifest.rules[gameVersion];
  const grid = GRIDS.find((entry) => entry.id === options.grid) ?? GRIDS[1];
  return (
    <article aria-label="Rules" className="ym-pr ym-pr-rules">
      <p>
        {`This game: a ${String(grid.columns)} × ${String(grid.rows)} grid of cards, ${String(grid.pairs)} pairs to find, and a limit of ${grid.moveLimit.toLocaleString("en")} moves.`}
      </p>
      {rules === undefined ? (
        <p>The rules for this version are unavailable.</p>
      ) : (
        blocks(rules).map((block, index) => {
          switch (block.kind) {
            case "heading":
              return <h3 key={index}>{block.text}</h3>;
            case "list": {
              const List = block.ordered ? "ol" : "ul";
              return (
                <List key={index}>
                  {block.items.map((item, i) => (
                    <li key={i}>
                      {inline(item.text)}
                      {item.subs.length === 0 ? null : (
                        <ul>
                          {item.subs.map((sub, j) => (
                            <li key={j}>{inline(sub)}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </List>
              );
            }
            case "paragraph":
              return <p key={index}>{inline(block.text)}</p>;
          }
        })
      )}
    </article>
  );
}
