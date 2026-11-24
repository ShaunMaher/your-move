/**
 * Every vulnerability ignored in osv-scanner.toml must be an accepted risk (11 §6): an
 * `ignoreUntil` date, and a `reason` naming an `F-<n>` entry in docs/security/findings.md that is
 * `accepted-risk` and whose "Review by" is the same date.
 */
import { parse } from "smol-toml";

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

/**
 * The keys an `IgnoredVulns` entry may set, spelled exactly. osv-scanner's TOML decoder matches
 * keys to its fields case-insensitively, so `ID` or `IGNOREUNTIL` beside the checked key could
 * override it; refusing every other spelling also refuses every duplicate after case folding.
 */
const ENTRY_KEYS: ReadonlySet<string> = new Set(["id", "ignoreUntil", "reason"]);

/** A TOML value as text: strings as they are, dates as `YYYY-MM-DD`, anything else unset. */
function text(value: unknown, date = false): string | undefined {
  if (typeof value === "string") return value;
  if (date && value instanceof Date) return value.toISOString().slice(0, 10);
  return undefined;
}

/**
 * Reads the `IgnoredVulns` entries of osv-scanner.toml with a real TOML parser, so every form
 * osv-scanner accepts (comments after headers, spaced headers, inline arrays) is seen. Throws on
 * invalid TOML or an `IgnoredVulns` that isn't an array of tables, so the check fails closed.
 * Any other top-level key is refused too: `PackageOverrides` (and whatever osv-scanner adds) can
 * also silence findings, and nothing here checks those against an accepted risk. So is any entry
 * key other than `id`, `ignoreUntil` and `reason`.
 */
export function parseIgnoredVulns(source: string): IgnoredVuln[] {
  const config = parse(source);
  const others = Object.keys(config).filter((key) => key !== "IgnoredVulns");
  if (others.length > 0) {
    throw new Error(
      `osv-scanner.toml: only IgnoredVulns is allowed (found ${others.join(", ")}); other settings can silence findings without an accepted-risk entry`,
    );
  }
  const entries = config["IgnoredVulns"] ?? [];
  if (!Array.isArray(entries)) throw new Error("osv-scanner.toml: IgnoredVulns must be an array");
  return entries.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("osv-scanner.toml: every IgnoredVulns entry must be a table");
    }
    const fields = entry as Record<string, unknown>;
    const unknown = Object.keys(fields).filter((key) => !ENTRY_KEYS.has(key));
    if (unknown.length > 0) {
      throw new Error(
        `osv-scanner.toml: an IgnoredVulns entry may set only id, ignoreUntil and reason (found ${unknown.join(", ")}); osv-scanner reads keys case-insensitively, so another spelling could override a checked value`,
      );
    }
    return {
      id: text(fields["id"]),
      ignoreUntil: text(fields["ignoreUntil"], true),
      reason: text(fields["reason"]),
    };
  });
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
