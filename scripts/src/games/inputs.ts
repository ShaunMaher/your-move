/**
 * Bundler-input closure (docs/spec/10-roadmap.md M1, 02 §7.3): after the web, Node and Worker
 * builds, every file a bundler read from inside an installed game package must be a file
 * `games:verify` checked **for that role**: the Node and Worker bundles may read only what the
 * engine and manifest entry points reach (the files the engine ESLint rules ran on); the web
 * bundle may also read what the client entry point reaches. Whatever trick makes a bundler read
 * something else from a package (a nested `package.json`, a symlink, a case-folded name, an import
 * the rules didn't see) shows up here as an unchecked input, so this closes the class of bypasses
 * found in the M0 review (S2-1, S3-1) without naming each. Each record must also contain the entry
 * files it is expected to, so an empty or truncated record can't pass.
 *
 * Only **module** inputs are covered: what the bundlers report as modules they read. CSS and asset
 * `url()` references are not; game packages ship no CSS the app loads today.
 *
 * `games:verify` writes `generated/verified-files.json`; each build writes the list of its inputs
 * to `generated/bundles/<app>.json`, after `pnpm build` has deleted the previous ones
 * (`games:check-inputs --reset`); `pnpm games:check-inputs` compares them.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

/** The builds whose inputs are checked. Each writes `generated/bundles/<name>.json`. */
export const BUNDLES = ["web", "node", "worker"] as const;

/** One of {@link BUNDLES}. */
export type Bundle = (typeof BUNDLES)[number];

/**
 * Whether the web bundle imports each game's client entry point (through the generated client map).
 * It does since the game shell (alpha A4), so the web record must hold the client entries. Tests
 * pass both settings to `uncheckedInputs`.
 */
const WEB_BUNDLES_GAME_CLIENTS = true;

/** What `games:verify` checked in one package, by role (absolute paths). */
export interface CheckedPackage {
  readonly name: string;
  readonly dir: string;
  readonly entries: Readonly<Record<"engine" | "client" | "manifest", string>>;
  /** The files the engine and manifest entry points reach. */
  readonly engine: readonly string[];
  /** The files the client entry point reaches. */
  readonly client: readonly string[];
}

const verifiedSchema = z
  .object({
    packages: z.array(
      z
        .object({
          name: z.string(),
          dir: z.string(),
          entries: z.object({ engine: z.string(), client: z.string(), manifest: z.string() }),
          engine: z.array(z.string()),
          client: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();

type Verified = z.infer<typeof verifiedSchema>;

/** A build's inputs: paths relative to `baseDir` (relative to the file's own directory if absent). */
const bundleSchema = z.object({ baseDir: z.string(), inputs: z.array(z.string()) }).strict();

/** `generated/installed.json`: game type → package (see ./generate.ts). */
const installedSchema = z.record(z.string(), z.looseObject({ package: z.string() }));

/** Records what `games:verify` checked, as paths relative to the repository root. */
export function writeVerifiedFiles(rootDir: string, packages: readonly CheckedPackage[]): void {
  const rel = (file: string): string => relative(rootDir, file);
  const verified: Verified = {
    packages: packages.map((pkg) => ({
      name: pkg.name,
      dir: rel(pkg.dir),
      entries: {
        engine: rel(pkg.entries.engine),
        client: rel(pkg.entries.client),
        manifest: rel(pkg.entries.manifest),
      },
      engine: pkg.engine.map(rel).sort(),
      client: pkg.client.map(rel).sort(),
    })),
  };
  const file = join(rootDir, "generated", "verified-files.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(verified, null, 2)}\n`);
}

/** Deletes every build's record: `pnpm build` starts with this, so no record is left from before. */
export function resetBundleInputs(rootDir: string): void {
  rmSync(join(rootDir, "generated", "bundles"), { recursive: true, force: true });
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

/**
 * Resolves `path` against `baseDir`, through symlinks when it exists. The native realpath also
 * gives the on-disk case of every name, so a case-folded path on a case-insensitive file system
 * compares equal to the checked one.
 */
function realPath(baseDir: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(baseDir, path);
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

/** A verified package with its paths resolved, and the files each build may read from it. */
interface Allowed {
  readonly name: string;
  readonly dir: string;
  readonly entries: Readonly<Record<"engine" | "client" | "manifest", string>>;
  readonly engine: ReadonlySet<string>;
  readonly any: ReadonlySet<string>;
}

function resolvePackages(rootDir: string, verified: Verified): Allowed[] {
  const real = (file: string): string => realPath(rootDir, file);
  return verified.packages.map((pkg) => {
    const engine = new Set(pkg.engine.map(real));
    return {
      name: pkg.name,
      dir: real(pkg.dir),
      entries: {
        engine: real(pkg.entries.engine),
        client: real(pkg.entries.client),
        manifest: real(pkg.entries.manifest),
      },
      engine,
      any: new Set([...engine, ...pkg.client.map(real)]),
    };
  });
}

/** The entry points a build's record must contain, per package. */
function expectedEntries(
  bundle: Bundle,
  webClients: boolean,
): readonly ("engine" | "client" | "manifest")[] {
  if (bundle === "web") return webClients ? ["client"] : [];
  return ["engine", "manifest"];
}

/** Every package in `generated/installed.json` must have been verified. */
function unverifiedPackages(generated: string, packages: readonly Allowed[]): string[] {
  const file = join(generated, "installed.json");
  if (!existsSync(file)) return ["generated/installed.json is missing: run pnpm games:generate"];
  const installed = installedSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  return Object.values(installed)
    .map((game) => game.package)
    .filter((name) => !packages.some((pkg) => pkg.name === name))
    .map(
      (name) =>
        `${name} is installed (generated/installed.json) but not in generated/verified-files.json: run pnpm games:verify`,
    );
}

/** The problems with one build's record. */
function bundleProblems(
  rootDir: string,
  bundle: Bundle,
  file: string,
  packages: readonly Allowed[],
  webClients: boolean,
): string[] {
  const { baseDir, inputs } = bundleSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const paths = new Set(inputs.map((input) => realPath(resolve(dirname(file), baseDir), input)));
  const problems: string[] = [];
  for (const path of paths) {
    const owner = packages.find((pkg) => path === pkg.dir || path.startsWith(`${pkg.dir}${sep}`));
    if (owner === undefined) continue;
    if (!(bundle === "web" ? owner.any : owner.engine).has(path)) {
      problems.push(
        bundle === "web" || !owner.any.has(path)
          ? `the ${bundle} build read ${relative(rootDir, path)} from ${owner.name}, which games:verify didn't check`
          : `the ${bundle} build read ${relative(rootDir, path)} from ${owner.name}, which games:verify checked only as client code`,
      );
    }
  }
  for (const pkg of packages) {
    for (const entry of expectedEntries(bundle, webClients)) {
      if (!paths.has(pkg.entries[entry])) {
        problems.push(
          `the ${bundle} build didn't read ${relative(rootDir, pkg.entries[entry])}, the ${entry} entry point of ${pkg.name}: its record is incomplete`,
        );
      }
    }
  }
  return problems;
}

/**
 * Every bundler input inside an installed game package that `games:verify` didn't check for that
 * build's role, every expected entry point a record lacks, and every installed package that wasn't
 * verified; also a problem for each missing record, so a build that skipped writing one fails
 * closed.
 */
export function uncheckedInputs(
  rootDir: string,
  bundles: readonly Bundle[] = BUNDLES,
  webClients = WEB_BUNDLES_GAME_CLIENTS,
): string[] {
  const generated = join(rootDir, "generated");
  const verifiedFile = join(generated, "verified-files.json");
  if (!existsSync(verifiedFile)) {
    return ["generated/verified-files.json is missing: run pnpm games:verify first"];
  }
  const verified = verifiedSchema.parse(JSON.parse(readFileSync(verifiedFile, "utf8")));
  const packages = resolvePackages(rootDir, verified);
  const problems = unverifiedPackages(generated, packages);
  for (const bundle of bundles) {
    const file = join(generated, "bundles", `${bundle}.json`);
    if (!existsSync(file)) {
      problems.push(
        `generated/bundles/${bundle}.json is missing: the ${bundle} build didn't record its inputs`,
      );
      continue;
    }
    problems.push(...bundleProblems(rootDir, bundle, file, packages, webClients));
  }
  return problems;
}
