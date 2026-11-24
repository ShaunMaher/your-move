/**
 * Registry credentials never go in the repository's `.npmrc`. pnpm ignores credentials in a
 * repository-controlled config that name an environment variable (https://pnpm.io/npmrc), and a
 * literal token there would sit in the checkout, where artifacts and caches can pick it up. So
 * every CI line that writes a credential must write it to a user-level file outside the checkout,
 * named by a job variable, and `publish:packages` must point pnpm at that file and delete it.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");

/** An npm config key that carries a credential. */
const CREDENTIAL = /_auth(?:Token)?\b|_password\b|\btokenHelper\b/u;

interface Job {
  readonly variables?: Record<string, unknown>;
  readonly before_script?: unknown[];
  readonly script?: unknown[];
  readonly after_script?: unknown[];
  readonly artifacts?: { readonly paths?: string[] };
  readonly cache?: unknown;
}

/** Every job (keys that aren't GitLab's own top-level keywords) with its script lines. */
function jobs(gitlabCi: string): Map<string, Job> {
  const doc = parse(gitlabCi, { merge: true }) as Record<string, unknown>;
  const keywords = new Set(["default", "include", "stages", "variables", "workflow", "spec"]);
  return new Map(
    Object.entries(doc).filter(
      (entry): entry is [string, Job] =>
        !keywords.has(entry[0]) && typeof entry[1] === "object" && entry[1] !== null,
    ),
  );
}

/** A job's shell lines, with multi-line entries (anchors, block scalars) split. */
function lines(job: Job): string[] {
  return [job.before_script, job.script, job.after_script]
    .flatMap((part) => part ?? [])
    .flat(Infinity)
    .flatMap((entry) => String(entry).split("\n"));
}

/** Where a line redirects its output: `> "$X"` or `>> file` → `$X` or `file`. */
function redirectTarget(line: string): string | undefined {
  const target = />>?\s*("?)([^\s"]+)\1/u.exec(line)?.[2];
  return target === undefined ? undefined : target.replace(/^\$\{?(\w+)\}?$/u, "$$$1");
}

/** Every problem with how one job writes registry credentials. */
function credentialProblems(name: string, job: Job): string[] {
  const problems: string[] = [];
  for (const line of lines(job)) {
    if (!CREDENTIAL.test(line)) continue;
    const target = redirectTarget(line);
    if (/\.npmrc\b/u.test(line) || !target?.startsWith("$")) {
      problems.push(`${name}: writes a credential outside a user-level config file: ${line}`);
      continue;
    }
    const path = job.variables?.[target.slice(1)];
    if (typeof path !== "string" || !path.startsWith("/tmp/") || path.includes("$")) {
      problems.push(`${name}: ${target} must be a fixed path under /tmp, outside the checkout`);
    }
    if (!line.trim().startsWith("(umask 077 && printf ")) {
      problems.push(`${name}: write the credential with printf under umask 077: ${line}`);
    }
  }
  return problems;
}

describe("registry credentials in .gitlab-ci.yml", () => {
  const all = jobs(read(".gitlab-ci.yml"));

  it("are never written into the repository's .npmrc", () => {
    expect([...all].flatMap(([name, job]) => credentialProblems(name, job))).toEqual([]);
  });

  it("are not in the committed .npmrc", () => {
    expect(read(".npmrc")).not.toMatch(CREDENTIAL);
  });

  describe("publish:packages", () => {
    const job = all.get("publish:packages");
    const shell = job === undefined ? [] : lines(job);
    const config = job?.variables?.["PUBLISH_NPMRC"];

    it("writes the deploy token to PUBLISH_NPMRC and points pnpm at it", () => {
      expect(config).toMatch(/^\/tmp\/[\w.-]+$/u);
      expect(shell).toContainEqual(
        expect.stringMatching(/RELEASE_DEPLOY_TOKEN.*> "\$PUBLISH_NPMRC"/u),
      );
      expect(shell).toContain('export NPM_CONFIG_USERCONFIG="$PUBLISH_NPMRC"');
      expect(shell.join("\n")).not.toMatch(/CI_JOB_TOKEN/u);
    });

    it("deletes it in after_script and never keeps it", () => {
      expect(job?.after_script).toContain('rm -f "$PUBLISH_NPMRC"');
      expect(JSON.stringify(job?.artifacts ?? {})).not.toContain(String(config));
      expect(JSON.stringify(job?.cache ?? {})).not.toContain(String(config));
    });
  });
});

describe("credentialProblems", () => {
  const job = (line: string, variables: Record<string, unknown> = {}): Job => ({
    variables,
    script: [line],
  });
  const good = `(umask 077 && printf '%s:_authToken=%s\\n' "$R" "$T" > "$CONFIG")`;

  it("accepts a printf under umask 077 to a /tmp file named by a job variable", () => {
    expect(credentialProblems("j", job(good, { CONFIG: "/tmp/j.npmrc" }))).toEqual([]);
  });

  it("rejects a credential appended to the repository's .npmrc", () => {
    expect(credentialProblems("j", job('echo "${R}:_authToken=\\${T}" >> .npmrc'))).toEqual([
      expect.stringMatching(/outside a user-level config/u),
    ]);
    expect(credentialProblems("j", job('echo "_auth=$T" >> "$CI_PROJECT_DIR/.npmrc"'))).toEqual([
      expect.stringMatching(/outside a user-level config/u),
    ]);
  });

  it("rejects a credential set through a command, not a redirect", () => {
    expect(credentialProblems("j", job('pnpm config set "${R}:_authToken" "$T"'))).toEqual([
      expect.stringMatching(/outside a user-level config/u),
    ]);
  });

  it("rejects a file inside the checkout or written without a 0600 umask", () => {
    expect(credentialProblems("j", job(good, { CONFIG: "$CI_PROJECT_DIR/x" }))).toEqual([
      expect.stringMatching(/fixed path under \/tmp/u),
    ]);
    expect(
      credentialProblems(
        "j",
        job(`printf '%s:_authToken=%s\\n' "$R" "$T" > "$CONFIG"`, { CONFIG: "/tmp/x" }),
      ),
    ).toEqual([expect.stringMatching(/umask 077/u)]);
  });

  it("reads anchors and multi-line entries", () => {
    expect(
      credentialProblems("j", { before_script: [["set -e\necho _authToken=x >> .npmrc"]] }),
    ).toHaveLength(1);
  });
});
