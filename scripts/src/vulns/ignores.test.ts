import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checkIgnores, parseFindings, parseIgnoredVulns } from "./ignores.js";

const FINDINGS = parseFindings(`
| Id | Status | Source | Risk | Rationale | Review by |
|---|---|---|---|---|---|
| F-11 | accepted-risk | OSV | A dev-only advisory | Not shipped | 2027-01-31 |
| F-12 | fixed | OSV | Old | Upgraded | 2026-12-01 |
| F-13 | accepted-risk | 08 | Something | Reason | M4 |
`);

const toml = (entry: string) => `# comment\n[[IgnoredVulns]]\n${entry}\n`;

describe("parseIgnoredVulns", () => {
  it("reads ids, dates and reasons, ignoring comments", () => {
    expect(
      parseIgnoredVulns(
        '# note\n[[IgnoredVulns]]\nid = "GHSA-1"\nignoreUntil = 2027-01-31\nreason = "F-11: dev only" # why\n',
      ),
    ).toEqual([{ id: "GHSA-1", ignoreUntil: "2027-01-31", reason: "F-11: dev only" }]);
  });

  const ONE = [{ id: "GHSA-1", ignoreUntil: "2027-01-31", reason: "F-11" }];

  it.each([
    [
      "a comment after the header",
      '[[IgnoredVulns]] # note\nid = "GHSA-1"\nignoreUntil = 2027-01-31\nreason = "F-11"\n',
    ],
    [
      "a spaced header",
      '[[ IgnoredVulns ]]\nid = "GHSA-1"\nignoreUntil = 2027-01-31\nreason = "F-11"\n',
    ],
    [
      "an inline array",
      'IgnoredVulns = [{ id = "GHSA-1", ignoreUntil = 2027-01-31, reason = "F-11" }]\n',
    ],
    [
      "a date-time",
      '[[IgnoredVulns]]\nid = "GHSA-1"\nignoreUntil = 2027-01-31T00:00:00Z\nreason = "F-11"\n',
    ],
    [
      "a quoted key",
      '[["IgnoredVulns"]]\n"id" = "GHSA-1"\nignoreUntil = 2027-01-31\nreason = "F-11"\n',
    ],
  ])("reads an entry written with %s", (_, source) => {
    expect(parseIgnoredVulns(source)).toEqual(ONE);
  });

  it("leaves a value of the wrong type unset, so the check reports it", () => {
    const [entry] = parseIgnoredVulns('[[IgnoredVulns]]\nid = 1\nignoreUntil = "soon"\n');
    expect(entry).toEqual({ id: undefined, ignoreUntil: "soon", reason: undefined });
    expect(checkIgnores(parseIgnoredVulns("[[IgnoredVulns]]\nid = 1\n"), FINDINGS)).toEqual([
      "(an entry without an id): needs ignoreUntil = YYYY-MM-DD",
    ]);
  });

  it.each([
    ["invalid TOML", "[[IgnoredVulns]\nid = 1\n"],
    ["IgnoredVulns as a single table", '[IgnoredVulns]\nid = "GHSA-1"\n'],
    ["an entry that isn't a table", 'IgnoredVulns = ["GHSA-1"]\n'],
    ["a PackageOverrides ignore", '[[PackageOverrides]]\nname = "x"\nignore = true\n'],
    [
      "a PackageOverrides vulnerability ignore",
      '[[PackageOverrides]]\nname = "x"\n[PackageOverrides.vulnerability]\nignore = true\n',
    ],
    ["any other top-level key", 'GoVersionOverride = "1.22"\n'],
  ])("fails closed on %s", (_, source) => {
    expect(() => parseIgnoredVulns(source)).toThrow();
  });

  it("finds no ignores in the committed file", () => {
    const committed = readFileSync(new URL("../../../osv-scanner.toml", import.meta.url), "utf8");
    expect(checkIgnores(parseIgnoredVulns(committed), FINDINGS)).toEqual([]);
  });
});

describe("checkIgnores", () => {
  it("accepts an ignore backed by an accepted risk with the same expiry", () => {
    const ignores = parseIgnoredVulns(
      toml('id = "GHSA-1"\nignoreUntil = 2027-01-31\nreason = "F-11: dev only"'),
    );
    expect(checkIgnores(ignores, FINDINGS)).toEqual([]);
  });

  it.each([
    ['id = "GHSA-1"\nreason = "F-11"', /needs ignoreUntil/u],
    ['id = "GHSA-1"\nignoreUntil = 2027-01-31\nreason = "dev only"', /must name an accepted-risk/u],
    ['id = "GHSA-1"\nignoreUntil = 2027-01-31\nreason = "F-99"', /F-99 is not in/u],
    ['id = "GHSA-1"\nignoreUntil = 2026-12-01\nreason = "F-12"', /"fixed", not accepted-risk/u],
    ['id = "GHSA-1"\nignoreUntil = 2027-02-28\nreason = "F-11"', /must be reviewed by 2027-02-28/u],
    ['id = "GHSA-1"\nignoreUntil = 2027-01-31\nreason = "F-13"', /it says "M4"/u],
  ])("rejects %j", (entry, expected) => {
    expect(checkIgnores(parseIgnoredVulns(toml(entry)), FINDINGS).join("\n")).toMatch(expected);
  });
});

describe("parseFindings", () => {
  it("reads the committed findings table", () => {
    const committed = parseFindings(
      readFileSync(new URL("../../../docs/security/findings.md", import.meta.url), "utf8"),
    );
    expect(committed.get("F-1")?.status).toBe("accepted-risk");
  });
});
