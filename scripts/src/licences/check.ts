/**
 * The production-dependency licence check (docs/spec/11-engineering.md §6): every package that
 * ships must be under an allow-listed licence or have an owner decision in docs/licences.md.
 * Input is `pnpm licenses list --prod --json --recursive`.
 */
import { z } from "zod";

import { isAllowedExpression } from "./policy.js";

const reportSchema = z.record(
  z.string(),
  z.array(z.looseObject({ name: z.string(), versions: z.array(z.string()) })),
);

export interface LicenceException {
  readonly name: string;
  readonly licence: string;
}

export interface LicenceViolation {
  readonly name: string;
  readonly versions: readonly string[];
  readonly licence: string;
}

/**
 * Reads the accepted exceptions from the first Markdown table under the heading
 * `## Accepted exceptions`: columns are package, licence, decision. Backticks are ignored.
 */
export function parseExceptions(markdown: string): LicenceException[] {
  const section = markdown.split(/^## Accepted exceptions\s*$/mu)[1]?.split(/^## /mu)[0] ?? "";
  const exceptions: LicenceException[] = [];
  for (const line of section.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/gu, "")
      .split("|")
      .map((cell) => cell.trim().replace(/`/gu, ""));
    const [name, licence] = cells;
    if (!name || !licence || /^-+$/u.test(name) || name.toLowerCase() === "package") continue;
    exceptions.push({ name, licence });
  }
  return exceptions;
}

/** Every package in the report whose licence is neither allowed nor an accepted exception. */
export function findViolations(
  reportJson: string,
  exceptions: readonly LicenceException[],
): LicenceViolation[] {
  const report = reportSchema.parse(JSON.parse(reportJson));
  const violations: LicenceViolation[] = [];
  for (const [licence, packages] of Object.entries(report)) {
    if (isAllowedExpression(licence)) continue;
    for (const pkg of packages) {
      const accepted = exceptions.some(
        (exception) => exception.name === pkg.name && exception.licence === licence,
      );
      if (!accepted) violations.push({ name: pkg.name, versions: pkg.versions, licence });
    }
  }
  return violations.sort((a, b) => a.name.localeCompare(b.name));
}
