/**
 * Reading an installed game package: its `package.json` and its three entry points
 * (docs/spec/02-game-framework.md §7.1).
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

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
  /** Absolute path of each entry point's module. */
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

type ExportTarget = string | { readonly [condition: string]: ExportTarget } | null;
const exportTargetSchema: z.ZodType<ExportTarget> = z.lazy(() =>
  z.union([z.string(), z.null(), z.record(z.string(), exportTargetSchema)]),
);

const packageJsonSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  license: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  exports: z.record(z.string(), exportTargetSchema).optional(),
});

/** Picks the ESM target of one `exports` entry: `import`, then `default`, depth first. */
function exportTarget(target: ExportTarget | undefined): string | null {
  if (target === undefined || target === null) return null;
  if (typeof target === "string") return target;
  for (const condition of ["import", "default"]) {
    const found = exportTarget(target[condition]);
    if (found !== null) return found;
  }
  return null;
}

export type ReadResult =
  | { readonly ok: true; readonly pkg: GamePackage }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Reads a game package and checks it has the three entry points. */
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
  const problems: string[] = [];
  const entries: Partial<Record<EntryPoint, string>> = {};
  for (const entry of ENTRY_POINTS) {
    const target = exportTarget(parsed.data.exports?.[`./${entry}`]);
    const file = target === null ? null : resolve(dir, target);
    if (file === null || !file.startsWith(`${dir}/`) || !existsSync(file)) {
      problems.push(`${name}: missing the "./${entry}" entry point (02 §7.1)`);
    } else {
      entries[entry] = file;
    }
  }
  if (problems.length > 0 || !entries.engine || !entries.client || !entries.manifest) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    pkg: {
      name: parsed.data.name,
      version: parsed.data.version,
      license: parsed.data.license,
      dependencies: parsed.data.dependencies ?? {},
      peerDependencies: parsed.data.peerDependencies ?? {},
      dir,
      entries: { engine: entries.engine, client: entries.client, manifest: entries.manifest },
    },
  };
}
