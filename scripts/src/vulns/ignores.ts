/**
 * Every vulnerability ignored in osv-scanner.toml must be an accepted risk (11 §6): an
 * `ignoreUntil` date, and a `reason` naming an `F-<n>` entry in docs/security/findings.md that is
 * `accepted-risk` and whose "Review by" is the same date.
 */

export interface IgnoredVuln {
  readonly id: string | undefined;
  readonly ignoreUntil: string | undefined;
  readonly reason: string | undefined;
}

export interface Finding {
  readonly status: string;
  readonly reviewBy: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** Reads the `[[IgnoredVulns]]` tables of osv-scanner.toml (string and date values only). */
export function parseIgnoredVulns(toml: string): IgnoredVuln[] {
  const entries: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      current = line === "[[IgnoredVulns]]" ? {} : null;
      if (current) entries.push(current);
      continue;
    }
    const match = /^([A-Za-z]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|(\S+))\s*(?:#.*)?$/u.exec(line);
    if (current && match?.[1] !== undefined) {
      current[match[1]] = match[2] ?? match[3] ?? "";
    }
  }
  return entries.map((entry) => ({
    id: entry["id"],
    ignoreUntil: entry["ignoreUntil"]?.slice(0, 10),
    reason: entry["reason"],
  }));
}

/** Reads the findings table of docs/security/findings.md: id → status and "Review by". */
export function parseFindings(markdown: string): Map<string, Finding> {
  const findings = new Map<string, Finding>();
  for (const line of markdown.split("\n")) {
    const cells = line
      .trim()
      .replace(/^\||\|$/gu, "")
      .split("|")
      .map((cell) => cell.trim());
    const [id, status] = cells;
    const reviewBy = cells.at(-1);
    if (id && /^F-\d+$/u.test(id) && status && reviewBy) {
      findings.set(id, { status, reviewBy });
    }
  }
  return findings;
}

/** Problems with the ignores; empty when each is a recorded, dated accepted risk. */
export function checkIgnores(
  ignores: readonly IgnoredVuln[],
  findings: ReadonlyMap<string, Finding>,
): string[] {
  const problems: string[] = [];
  for (const ignore of ignores) {
    const label = ignore.id ?? "(an entry without an id)";
    if (ignore.ignoreUntil === undefined || !DATE.test(ignore.ignoreUntil)) {
      problems.push(`${label}: needs ignoreUntil = YYYY-MM-DD`);
      continue;
    }
    const ref = /\bF-\d+\b/u.exec(ignore.reason ?? "")?.[0];
    if (ref === undefined) {
      problems.push(`${label}: its reason must name an accepted-risk entry (F-<n>)`);
      continue;
    }
    const finding = findings.get(ref);
    if (finding === undefined) {
      problems.push(`${label}: ${ref} is not in docs/security/findings.md`);
    } else if (finding.status !== "accepted-risk") {
      problems.push(`${label}: ${ref} is "${finding.status}", not accepted-risk`);
    } else if (finding.reviewBy !== ignore.ignoreUntil) {
      problems.push(
        `${label}: ${ref} must be reviewed by ${ignore.ignoreUntil}, the date the ignore expires (it says "${finding.reviewBy}")`,
      );
    }
  }
  return problems;
}
