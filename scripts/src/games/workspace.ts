/**
 * This repository's workspace packages (pnpm-workspace.yaml `packages`). `games:verify` resolves
 * pnpm's `workspace:` protocol only for these: a package installed from a registry was published,
 * and publishing replaces every `workspace:` range, so one that still has them is unpublishable.
 */
import { execFileSync } from "node:child_process";
import { globSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { parse } from "yaml";

import type { PackageResolver } from "./packages.js";

/** The real paths of the workspace packages under `rootDir`. */
export function workspacePackageDirs(rootDir: string): ReadonlySet<string> {
  const config = parse(readFileSync(join(rootDir, "pnpm-workspace.yaml"), "utf8")) as unknown;
  const globs =
    typeof config === "object" && config !== null && "packages" in config ? config.packages : [];
  if (!Array.isArray(globs) || !globs.every((glob) => typeof glob === "string")) {
    throw new Error("pnpm-workspace.yaml: packages must be a list of globs");
  }
  if (globs.some((glob) => glob.startsWith("!"))) {
    // Exclusions would need pnpm's own matching; fail rather than count too many packages.
    throw new Error("pnpm-workspace.yaml: workspacePackageDirs doesn't support negated globs");
  }
  const manifests = globSync(
    globs.map((glob) => `${glob}/package.json`),
    { cwd: rootDir },
  );
  return new Set(manifests.map((file) => realpathSync(join(rootDir, dirname(file)))));
}

/**
 * Builds every installed game package that is a package of this workspace, with its own `build`
 * script, before anything reads its entry points: a workspace package is consumed exactly like a
 * published one, through its built `exports` (02 §7.1.1), so its `dist/` must be current. Packages
 * from a registry are already built.
 */
export function buildWorkspaceGames(
  instance: { readonly games: readonly { readonly package: string }[] },
  resolvePackage: PackageResolver,
  workspaceDirs: ReadonlySet<string>,
): void {
  for (const { package: name } of instance.games) {
    const dir = resolvePackage(name);
    if (dir !== null && workspaceDirs.has(dir)) {
      execFileSync("pnpm", ["run", "build"], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
    }
  }
}
