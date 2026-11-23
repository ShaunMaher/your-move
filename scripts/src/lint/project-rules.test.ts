import { Linter } from "eslint";
import { describe, expect, it } from "vitest";

import { projectRules } from "./project-rules.js";

const linter = new Linter({ configType: "flat" });

function lint(code: string): string[] {
  return linter
    .verify(
      code,
      [
        {
          languageOptions: {
            ecmaVersion: 2023,
            sourceType: "module",
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
          plugins: { "your-move": projectRules },
          rules: { "your-move/no-product-name": "error", "your-move/no-dangerous-html": "error" },
        },
      ],
      "file.js",
    )
    .map((message) => message.ruleId ?? message.message);
}

const NAME = ["Your", "Move"].join(" ");

describe("no-product-name", () => {
  it.each([
    `export const title = "${NAME}";`,
    `export const title = \`Welcome to ${NAME}\`;`,
    `export const el = <h1>${NAME}</h1>;`,
  ])("flags the default product name: %s", (code) => {
    expect(lint(code)).toEqual(["your-move/no-product-name"]);
  });

  it.each([
    'export const turn = "Your move!";',
    'export const turn = "your move";',
    "export const el = <p>Your move, Ana</p>;",
    'export const other = "Your Moves";'.replace("Moves", "Mover"),
  ])("allows ordinary copy: %s", (code) => {
    expect(lint(code)).toEqual([]);
  });
});

describe("no-dangerous-html", () => {
  it.each([
    "export const el = <div dangerouslySetInnerHTML={{ __html: x }} />;",
    "export const props = { dangerouslySetInnerHTML: { __html: x } };",
  ])("flags %s", (code) => {
    expect(lint(`const x = "";\n${code}`)).toContain("your-move/no-dangerous-html");
  });
});
