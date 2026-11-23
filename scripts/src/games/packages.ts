/**
 * Reading an installed game package: its `package.json` and its three entry points
 * (docs/spec/02-game-framework.md §7.1, §7.1.1).
 *
 * The package contract is checked strictly and fails closed, because what `games:verify` checks
 * must be exactly what bundlers and Node load: every `exports` entry is `{ types, import }` and
 * nothing else (no other conditions a bundler might prefer, no nesting, no string shorthand), no
 * `imports` or `browser` remapping, ESM only, and every target resolves (symlinks included) to a
 * file inside the package. Nothing inside the package may change how its files are read either: no
 * other `package.json` (whose `imports`, `browser` and `type` Node and bundlers honour), no
 * `node_modules` (bundled dependencies) and no CommonJS.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { z } from "zod";

const ENTRY_POINTS = ["engine", "client", "manifest"] as const;
type EntryPoint = (typeof ENTRY_POINTS)[number];

export interface GamePackage {
  readonly name: string;
  readonly version: string;
  /** `package.json` `license`, if any. */
  readonly license: string | undefined;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  /** The package directory (symlinks resolved). */
  readonly dir: string;
  /** Absolute path of each entry point's module (symlinks resolved). */
  readonly entries: Readonly<Record<EntryPoint, string>>;
}

/** Finds a package's directory by name, or `null` if it isn't installed. */
export type PackageResolver = (name: string) => string | null;

/** Resolves packages the way the instance build does: from the root's `node_modules`. */
export function nodeModulesResolver(rootDir: string): PackageResolver {
  return (name) => {
    const dir = join(rootDir, "node_modules", name);
    return existsSync(join(dir, "package.json")) ? realpathSync(dir) : null;
  };
}

/** The only shape an `exports` entry may have (02 §7.1.1). */
const exportEntrySchema = z.object({ types: z.string(), import: z.string() }).strict();

const packageJsonSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  type: z.string().optional(),
  license: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  exports: z.unknown().optional(),
  imports: z.unknown().optional(),
  browser: z.unknown().optional(),
});

export type ReadResult =
  | { readonly ok: true; readonly pkg: GamePackage }
  | { readonly ok: false; readonly problems: readonly string[] };

/** The real path of `target` if it exists inside `dir` (itself a real path), else null. */
function containedFile(dir: string, target: string): string | null {
  const file = resolve(dir, target);
  if (!existsSync(file)) return null;
  const real = realpathSync(file);
  return real.startsWith(`${dir}${sep}`) ? real : null;
}

/** What an `exports` target must end with: ESM JavaScript, and its declarations. */
const TARGET_EXTENSIONS = {
  import: [".js", ".mjs"],
  types: [".d.ts", ".d.mts"],
} as const;

/**
 * Problems with the files inside a game package (02 §7.1.1): another `package.json`, a
 * `node_modules` directory or a CommonJS file (by name, symlinks included), and any symlink in a
 * package from a registry (or, in a workspace package, one leading out of it). A workspace package's
 * own top-level `node_modules` is where pnpm links its development dependencies, and is skipped;
 * a published package never has one, so for anything installed from a registry it is refused.
 */
export function packageFileProblems(name: string, dir: string, workspace: boolean): string[] {
  const problems: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const rel = relative(dir, path);
      if (entry.name === "node_modules") {
        if (!(workspace && current === dir)) {
          problems.push(`${name}: must not contain a node_modules directory (${rel}) (02 §7.1.1)`);
        }
        continue;
      }
      // Checked by name first, so a symlink can't hide a package.json or a CommonJS file.
      if (entry.name === "package.json" && current !== dir) {
        problems.push(
          `${name}: must not contain another package.json (${rel}): Node and bundlers would read its "imports", "browser" and "type" (02 §7.1.1)`,
        );
      } else if (/\.c[jt]s$/u.test(entry.name)) {
        problems.push(`${name}: must not contain CommonJS (${rel}) (02 §7.1.1)`);
      }
      if (entry.isSymbolicLink()) {
        if (!workspace) {
          // A published tarball can't carry symlinks, so one here didn't come from a registry.
          problems.push(`${name}: must not contain a symlink (${rel}) (02 §7.1.1)`);
        } else if (existsSync(path) && !realpathSync(path).startsWith(`${dir}${sep}`)) {
          problems.push(`${name}: ${rel} links outside the package`);
        }
        // A link inside a workspace package is checked where it points.
        continue;
      }
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return problems;
}

/** Reads a game package and checks its `package.json` contract and three entry points. */
export function readGamePackage(name: string, resolvePackage: PackageResolver): ReadResult {
  const dir = resolvePackage(name);
  if (dir === null) {
    return { ok: false, problems: [`${name}: not installed (add it to the root package.json)`] };
  }
  const parsed = packageJsonSchema.safeParse(
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")),
  );
  if (!parsed.success) {
    return { ok: false, problems: [`${name}: package.json has no valid name and version`] };
  }
  const json = parsed.data;
  const problems: string[] = [];
  if (json.type !== "module") {
    problems.push(`${name}: must be ESM ("type": "module") (02 §7.1.1)`);
  }
  for (const field of ["imports", "browser"] as const) {
    if (json[field] !== undefined) {
      problems.push(`${name}: must not have a package.json "${field}" field (02 §7.1.1)`);
    }
  }

  const exportsMap = z.record(z.string(), z.unknown()).safeParse(json.exports);
  const entries: Partial<Record<EntryPoint, string>> = {};
  if (!exportsMap.success || Object.keys(exportsMap.data).some((key) => !key.startsWith("."))) {
    problems.push(`${name}: "exports" must map subpaths to { types, import } (02 §7.1.1)`);
  } else {
    for (const [subpath, value] of Object.entries(exportsMap.data)) {
      const entry = exportEntrySchema.safeParse(value);
      if (!entry.success) {
        problems.push(
          `${name}: exports["${subpath}"] must be exactly { types, import }, with no other conditions (02 §7.1.1)`,
        );
        continue;
      }
      for (const [condition, extensions] of Object.entries(TARGET_EXTENSIONS)) {
        const target = entry.data[condition as keyof typeof TARGET_EXTENSIONS];
        if (!extensions.some((extension) => target.endsWith(extension))) {
          problems.push(
            `${name}: exports["${subpath}"].${condition} is "${target}"; it must end with ${extensions.join(" or ")} (02 §7.1.1)`,
          );
        }
        if (containedFile(dir, target) === null) {
          problems.push(
            `${name}: exports["${subpath}"] points at "${target}", which is not a file inside the package`,
          );
        }
      }
    }
    for (const point of ENTRY_POINTS) {
      const entry = exportEntrySchema.safeParse(exportsMap.data[`./${point}`]);
      const file = entry.success ? containedFile(dir, entry.data.import) : null;
      if (file === null) {
        problems.push(`${name}: missing the "./${point}" entry point (02 §7.1)`);
      } else {
        entries[point] = file;
      }
    }
  }

  if (problems.length > 0 || !entries.engine || !entries.client || !entries.manifest) {
    return { ok: false, problems: [...new Set(problems)] };
  }
  return {
    ok: true,
    pkg: {
      name: json.name,
      version: json.version,
      license: json.license,
      dependencies: json.dependencies ?? {},
      peerDependencies: json.peerDependencies ?? {},
      dir,
      entries: { engine: entries.engine, client: entries.client, manifest: entries.manifest },
    },
  };
}
