/**
 * Framework and runtime code never reads a game definition's `test` hooks (02 §6, findings F-11):
 * the hooks ship in every engine because they are part of the contract, but only the testkit and
 * `games:verify` may call them, so a kit bot or kit word list never runs on a request path.
 *
 * The check parses every non-test source file under the framework and the apps and refuses any
 * read of a property named `test`: `x.test` (unless it is called, as in `/re/.test(s)`),
 * `x["test"]`, and `{ test }` destructuring. That is stricter than "of a definition", on purpose:
 * nothing in these paths has another reason to read a `test` property.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The framework and app source trees the rule covers. */
function sourceRoots(): string[] {
  const apps = readdirSync(join(ROOT, "apps"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join("apps", entry.name, "src"));
  return ["packages/server/src", "packages/shared/src", ...apps];
}

/** Every source file under `dir` that isn't a test or test support. */
function sourceFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .filter((entry) => !/\.test\.tsx?$/u.test(entry.name) && !entry.name.startsWith("test-support"))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)));
}

/** The places in `source` that read a property named `test`, as "line:column". */
function testHookReads(source: string, fileName = "file.ts"): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const at = (node: ts.Node): void => {
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    found.push(`${String(line + 1)}:${String(character + 1)}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "test") {
      const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (!called) at(node);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "test"
    ) {
      at(node);
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === "test") at(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("the test hooks stay out of framework and runtime code (02 §6)", () => {
  it("finds every way of reading a test property, and allows calling RegExp.prototype.test", () => {
    const source = [
      "engines[1].test.randomAction(s, 0, rng, res);",
      "const hooks = def.test;",
      'def["test"]?.worstCase(o, 2, rng);',
      "const { test } = def;",
      "const { test: hooks2 } = def;",
      "if (/^a$/u.test(name)) ok();",
      "PATTERN.test(value);",
      "const t = { test: 1 };",
    ].join("\n");
    expect(testHookReads(source)).toEqual(["1:1", "2:15", "3:1", "4:9", "5:9"]);
  });

  it("finds none under packages/server, packages/shared or apps/*", () => {
    const files = sourceRoots().flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(5);
    const reads = files.flatMap((file) =>
      testHookReads(readFileSync(join(ROOT, file), "utf8"), file).map(
        (where) => `${file}:${where}`,
      ),
    );
    expect(reads).toEqual([]);
  });
});
