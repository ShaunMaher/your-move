/**
 * `pnpm lint:licences` (11 §6): every production dependency is under an allow-listed licence or
 * has an owner decision in docs/licences.md. Uses pnpm's own licence listing; no extra dependency.
 *
 * `--dir <path>` checks another (non-workspace) project instead, with this repository's
 * exceptions; `pnpm gates:prove` uses it on a fixture project with a GPL dependency.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { findViolations, parseExceptions } from "../licences/check.js";
import { fail, ROOT_DIR, run } from "./cli.js";

run("lint:licences", () => {
  const { values } = parseArgs({ options: { dir: { type: "string" } } });
  const args = ["licenses", "list", "--prod", "--json"];
  args.push(values.dir === undefined ? "--recursive" : "--ignore-workspace");
  const report = execFileSync("pnpm", args, {
    cwd: values.dir ?? ROOT_DIR,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const exceptions = parseExceptions(readFileSync(join(ROOT_DIR, "docs/licences.md"), "utf8"));
  const violations = findViolations(report, exceptions);
  if (violations.length > 0) {
    fail(
      "lint:licences",
      violations.map(
        (violation) =>
          `${violation.name}@${violation.versions.join(",")}: "${violation.licence}" is not on the allow-list; record an owner decision in docs/licences.md`,
      ),
    );
  }
  console.log("lint:licences: every production dependency is on the allow-list");
  return Promise.resolve();
});
