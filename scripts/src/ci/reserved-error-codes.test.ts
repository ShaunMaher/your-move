/**
 * The SDK's `RESERVED_ERROR_CODES` (02 §2.2) are "every code in the 05 table": this keeps the two
 * the same, so a framework code added to docs/spec/05-api.md can't be missed by the kit's reserved
 * code check. The table is parsed the way ./no-secrets-on-mr.test.ts parses docs/deploy.md.
 */
import { readFileSync } from "node:fs";

import { RESERVED_ERROR_CODES } from "@your-move/sdk";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");

/** The backticked codes in the `| Status | Codes |` table of the `## Errors` section. */
function documentedErrorCodes(markdown: string): string[] {
  const section = markdown.split(/^## /mu).find((part) => part.startsWith("Errors\n"));
  if (section === undefined) throw new Error("docs/spec/05-api.md has no ## Errors section");
  const rows = section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1));
  const [header, separator, ...body] = rows;
  if (header?.[0]?.trim() !== "Status" || header[1]?.trim() !== "Codes" || !separator) {
    throw new Error("docs/spec/05-api.md: the errors table must start | Status | Codes |");
  }
  // Only the leading code spans name codes; the notes in parentheses quote other things
  // (`players(options)`, `validateStart`), which never look like codes.
  return body.flatMap((cells) =>
    [...(cells[1] ?? "").matchAll(/`([A-Z][A-Z0-9_]*)`/gu)].map((match) => match[1] ?? ""),
  );
}

describe("RESERVED_ERROR_CODES", () => {
  const documented = documentedErrorCodes(read("docs/spec/05-api.md"));

  it("reads a non-empty errors table", () => {
    expect(documented).toContain("NOT_YOUR_TURN");
    expect(documented).toContain("UPLOADS_FULL");
  });

  it("is exactly the codes of the 05 §Errors table, each once", () => {
    expect(new Set(RESERVED_ERROR_CODES).size).toBe(RESERVED_ERROR_CODES.length);
    expect([...RESERVED_ERROR_CODES].sort()).toEqual([...new Set(documented)].sort());
  });
});

describe("the parser", () => {
  const table = (rows: string) =>
    `## Errors\n\nIntro:\n\n| Status | Codes |\n|---|---|\n${rows}\n\nText with \`NOT_A_CODE\`.\n\n## Next\n\n| Status | Codes |\n|---|---|\n| 1 | \`OTHER\` |\n`;

  it("reads every code in a row, skips non-code spans and stops at the section's end", () => {
    expect(
      documentedErrorCodes(table("| 400 | `A`, `B_2` (see `players(options)`) |\n| 409 | `C` |")),
    ).toEqual(["A", "B_2", "C"]);
  });

  it("refuses a table that doesn't start | Status | Codes |", () => {
    expect(() => documentedErrorCodes("## Errors\n\n| Code | Status |\n|---|---|\n")).toThrow(
      /must start \| Status \| Codes \|/u,
    );
    expect(() => documentedErrorCodes("## Other\n")).toThrow(/no ## Errors section/u);
  });
});
