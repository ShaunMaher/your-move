/**
 * The toolchain is pinned in more than one file (11 §1): Node in mise.toml, the Dockerfile and the
 * CI images; pnpm in mise.toml and `packageManager`. Renovate groups each across files (renovate.json),
 * and this check fails when they drift apart anyway.
 */
import { parse } from "smol-toml";

/** The files that pin Node or pnpm, by repository path. */
export interface PinnedFiles {
  readonly "mise.toml": string;
  readonly "package.json": string;
  readonly "apps/node/Dockerfile": string;
  readonly ".gitlab-ci.yml": string;
}

/** Every `node:<version>` image reference in `text`. */
function nodeImageVersions(text: string): string[] {
  return [...text.matchAll(/\bnode:(\d+\.\d+\.\d+)\b/gu)].map((match) => match[1] ?? "");
}

/** Problems with the pins; empty when every file agrees with mise.toml. */
export function checkPins(files: PinnedFiles): string[] {
  const tools = (parse(files["mise.toml"])["tools"] ?? {}) as Record<string, unknown>;
  const node = tools["node"];
  const pnpm = tools["pnpm"];
  if (typeof node !== "string" || typeof pnpm !== "string") {
    return ["mise.toml must pin node and pnpm to exact versions"];
  }
  const problems: string[] = [];
  for (const file of ["apps/node/Dockerfile", ".gitlab-ci.yml"] as const) {
    const versions = nodeImageVersions(files[file]);
    if (versions.length === 0) problems.push(`${file}: no node:<version> image found`);
    for (const version of new Set(versions.filter((version) => version !== node))) {
      problems.push(
        `${file} uses the node:${version} image but mise.toml pins node ${node}: update every Node pin together (Renovate's "Node" group does)`,
      );
    }
  }
  const { packageManager } = JSON.parse(files["package.json"]) as { packageManager?: unknown };
  const managerVersion =
    typeof packageManager === "string" ? /^pnpm@([^+]+)/u.exec(packageManager)?.[1] : undefined;
  if (managerVersion !== pnpm) {
    problems.push(
      `package.json "packageManager" is pnpm ${managerVersion ?? "(missing)"} but mise.toml pins pnpm ${pnpm}: update both, with the new sha512 (Renovate's "pnpm" group does)`,
    );
  }
  return problems;
}
