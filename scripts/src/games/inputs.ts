/**
 * Bundler-input closure (docs/spec/10-roadmap.md M1): after the web, Node and Worker builds, every
 * file a bundler read from inside an installed game package must be a file `games:verify` checked.
 * Whatever trick makes a bundler read something else from a package (a nested `package.json`, a
 * symlink, a case-folded name, an import the rules didn't see) shows up here as an unchecked input,
 * so this closes the class of bypasses found in the M0 review (S2-1, S3-1) without naming each.
 *
 * `games:verify` writes `generated/verified-files.json`; each build writes the list of its inputs
 * to `generated/bundles/<app>.json`; `pnpm games:check-inputs` compares them.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type { LoadedGame } from "./load.js";

/** The builds whose inputs are checked. Each writes `generated/bundles/<name>.json`. */
export const BUNDLES = ["web", "node", "worker"] as const;

/** One of {@link BUNDLES}. */
export type Bundle = (typeof BUNDLES)[number];

const verifiedSchema = z.object({
  packages: z.array(
    z.object({ name: z.string(), dir: z.string(), files: z.array(z.string()) }).strict(),
  ),
});

type Verified = z.infer<typeof verifiedSchema>;

/** A build's inputs: paths relative to `baseDir` (relative to the file's own directory if absent). */
const bundleSchema = z.object({ baseDir: z.string(), inputs: z.array(z.string()) }).strict();

/** Records what `games:verify` checked, as paths relative to the repository root. */
export function writeVerifiedFiles(
  rootDir: string,
  games: readonly LoadedGame[],
  checked: ReadonlySet<string>,
): void {
  const verified: Verified = {
    packages: games.map((game) => ({
      name: game.packageName,
      dir: relative(rootDir, game.pkg.dir),
      files: [...checked]
        .filter((file) => file.startsWith(`${game.pkg.dir}${sep}`))
        .map((file) => relative(rootDir, file))
        .sort(),
    })),
  };
  const file = join(rootDir, "generated", "verified-files.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(verified, null, 2)}\n`);
}

/**
 * Writes one build's inputs for the closure check. `baseDir` is what the bundler's paths are
 * relative to; virtual modules (a NUL prefix) and query strings are dropped.
 */
export function writeBundleInputs(
  rootDir: string,
  bundle: Bundle,
  baseDir: string,
  inputs: Iterable<string>,
): void {
  const clean = [
    ...new Set(
      [...inputs].filter((id) => !id.startsWith("\0")).map((id) => id.split("?")[0] ?? id),
    ),
  ].sort();
  const file = join(rootDir, "generated", "bundles", `${bundle}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ baseDir, inputs: clean }, null, 2)}\n`);
}

/** Resolves `path` against `baseDir`, through symlinks when it exists. */
function realPath(baseDir: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(baseDir, path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

/**
 * Every bundler input inside an installed game package that `games:verify` didn't check; also a
 * problem for each missing record, so a build that skipped writing one fails closed.
 */
export function uncheckedInputs(rootDir: string, bundles: readonly Bundle[] = BUNDLES): string[] {
  const generated = join(rootDir, "generated");
  const verifiedFile = join(generated, "verified-files.json");
  if (!existsSync(verifiedFile)) {
    return ["generated/verified-files.json is missing: run pnpm games:verify first"];
  }
  const verified = verifiedSchema.parse(JSON.parse(readFileSync(verifiedFile, "utf8")));
  const packages = verified.packages.map((pkg) => ({
    name: pkg.name,
    dir: realPath(rootDir, pkg.dir),
    files: new Set(pkg.files.map((file) => realPath(rootDir, file))),
  }));
  const problems: string[] = [];
  for (const bundle of bundles) {
    const file = join(generated, "bundles", `${bundle}.json`);
    if (!existsSync(file)) {
      problems.push(
        `generated/bundles/${bundle}.json is missing: the ${bundle} build didn't record its inputs`,
      );
      continue;
    }
    const { baseDir, inputs } = bundleSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    for (const input of inputs) {
      const path = realPath(resolve(dirname(file), baseDir), input);
      const owner = packages.find((pkg) => path === pkg.dir || path.startsWith(`${pkg.dir}${sep}`));
      if (owner !== undefined && !owner.files.has(path)) {
        problems.push(
          `the ${bundle} build read ${relative(rootDir, path)} from ${owner.name}, which games:verify didn't check`,
        );
      }
    }
  }
  return problems;
}
