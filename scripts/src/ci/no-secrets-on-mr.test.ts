/**
 * `security:no-secrets-on-mr` in .gitlab-ci.yml names every CI secret and environment by hand; the
 * list of secrets is the table in docs/deploy.md ("CI settings and secrets"). This keeps the two
 * the same, so a secret added to one can't be missed by the merge-request exposure check.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");

interface Secrets {
  readonly names: string[];
  readonly environments: string[];
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/** The backticked names in a table cell: "`A`, `B`" → A, B. */
const codeSpans = (cell: string) =>
  [...cell.matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? "");

/** The variables and environments in the secrets table of docs/deploy.md. */
function documentedSecrets(markdown: string): Secrets {
  const section = markdown
    .split(/^## /mu)
    .find((part) => part.startsWith("CI settings and secrets"));
  if (section === undefined) throw new Error('docs/deploy.md has no "CI settings and secrets"');
  const rows = section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1));
  const [header, separator, ...body] = rows;
  if (header?.[0]?.trim() !== "Variable" || header[1]?.trim() !== "Environment" || !separator) {
    throw new Error("docs/deploy.md: the secrets table must start | Variable | Environment |");
  }
  return {
    names: sorted(body.flatMap((cells) => codeSpans(cells[0] ?? ""))),
    environments: sorted(body.flatMap((cells) => codeSpans(cells[1] ?? ""))),
  };
}

/** The variables the exposure job checks, and the environments it runs in. */
function checkedSecrets(gitlabCi: string): Secrets {
  const job = (parse(gitlabCi) as Record<string, unknown>)["security:no-secrets-on-mr"] as
    { parallel?: { matrix?: { ENV?: string[] }[] }; script?: string[] } | undefined;
  const loop = /for name in ([^;]+);/u.exec((job?.script ?? []).join("\n"))?.[1];
  if (loop === undefined) throw new Error("security:no-secrets-on-mr has no `for name in …;` loop");
  return {
    names: sorted(loop.trim().split(/\s+/u)),
    environments: sorted(job?.parallel?.matrix?.flatMap((entry) => entry.ENV ?? []) ?? []),
  };
}

describe("security:no-secrets-on-mr", () => {
  const documented = documentedSecrets(read("docs/deploy.md"));
  const checked = checkedSecrets(read(".gitlab-ci.yml"));

  it("reads a non-empty secrets table", () => {
    expect(documented.names).toContain("RELEASE_DEPLOY_TOKEN");
    expect(documented.environments).toContain("release");
  });

  it("checks exactly the secrets docs/deploy.md lists", () => {
    expect(checked.names).toEqual(documented.names);
  });

  it("runs in exactly the environments docs/deploy.md lists", () => {
    expect(checked.environments).toEqual(documented.environments);
  });
});

describe("the parsers", () => {
  const table = (rows: string) =>
    `## CI settings and secrets\n\n| Variable | Environment | Used by |\n|---|---|---|\n${rows}\n\n## Next\n\n| \`OTHER\` | \`x\` | y |\n`;

  it("read every name in a row and stop at the section's end", () => {
    expect(documentedSecrets(table("| `A`, `B` | `env1` | x |\n| `C` | `env2` | y |"))).toEqual({
      names: ["A", "B", "C"],
      environments: ["env1", "env2"],
    });
  });

  it("fail when the table is missing or reshaped", () => {
    expect(() => documentedSecrets("## Other\n")).toThrow(/no "CI settings and secrets"/u);
    expect(() =>
      documentedSecrets("## CI settings and secrets\n\n| Name | Scope |\n|---|---|\n"),
    ).toThrow(/must start/u);
  });

  it("fail when the job has no loop over names", () => {
    expect(() => checkedSecrets("security:no-secrets-on-mr:\n  script: [exit 0]\n")).toThrow(
      /no `for name in/u,
    );
  });
});
