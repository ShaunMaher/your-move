/**
 * ESLint rules for project rules in CLAUDE.md that lint can check (11 §3). Loaded directly by
 * Node from eslint.config.js, so erasable TypeScript only, with no relative imports.
 */
import type { ESLint, Rule } from "eslint";

/**
 * The default product name, spelled exactly as the config default (`APP_NAME`). Matching is exact
 * and case-sensitive, so ordinary copy such as a "Your move!" turn indicator passes. Built from
 * parts so this file doesn't trip its own rule.
 */
const PRODUCT_NAME = new RegExp(`\\b${["Your", "Move"].join(" ")}\\b`, "u");

const noProductName: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "The product name comes from APP_NAME, never a literal (CLAUDE.md)." },
    messages: { literal: "Use APP_NAME from config; never hard-code the product name." },
    schema: [],
  },
  create(context) {
    const check = (node: Rule.Node, text: unknown): void => {
      if (typeof text === "string" && PRODUCT_NAME.test(text)) {
        context.report({ node, messageId: "literal" });
      }
    };
    return {
      Literal: (node) => {
        check(node, node.value);
      },
      TemplateElement: (node) => {
        check(node, node.value.raw);
      },
      // JSX text isn't in the ESTree types ESLint ships; the node carries a string `value`.
      JSXText: (node: Rule.Node) => {
        check(node, (node as unknown as { value: unknown }).value);
      },
    };
  },
};

const noDangerousHtml: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "No dangerouslySetInnerHTML anywhere (CLAUDE.md)." },
    messages: { banned: "dangerouslySetInnerHTML is banned." },
    schema: [],
  },
  create(context) {
    const check = (node: Rule.Node): void => {
      if ((node as unknown as { name?: unknown }).name === "dangerouslySetInnerHTML") {
        context.report({ node, messageId: "banned" });
      }
    };
    return { Identifier: check, JSXIdentifier: check };
  },
};

export const projectRules: ESLint.Plugin = {
  meta: { name: "your-move" },
  rules: { "no-product-name": noProductName, "no-dangerous-html": noDangerousHtml },
};
