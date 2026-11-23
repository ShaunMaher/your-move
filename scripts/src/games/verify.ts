/**
 * `pnpm games:verify` (docs/spec/02-game-framework.md §7.3, §7.5): the build-time checks every
 * installed game package must pass: type ids, the SDK peer range, licences, the dependency rules
 * of 02 §7.1.1, the import ruleset and the engine ESLint rules on built output, the generic test
 * kit (fast or full), and the manifest-versus-engine and icon checks.
 * The package contract itself (02 §7.1.1) is checked when the package is read (./packages.ts) and,
 * for the files inside it, here.
 */
import { relative, resolve, sep } from "node:path";

import { isGameType } from "@your-move/sdk";
import { runKit, type KitMode } from "@your-move/testkit";
import { gamePackageRules } from "@your-move/testkit/depcruise";
import { engineEslintConfig } from "@your-move/testkit/eslint-engine";
import { cruise, type ICruiseResult } from "dependency-cruiser";
import { ESLint } from "eslint";
import { satisfies, validRange } from "semver";

import { isAllowedExpression } from "../licences/policy.js";
import type { LoadedGame } from "./load.js";
import { packageFileProblems, packedFiles } from "./packages.js";

/** The instance supplies these; a game names them only as peers (02 §7.1.1). */
const ALLOWED_PEERS: ReadonlySet<string> = new Set(["@your-move/sdk", "react", "zod"]);

export interface VerifyOptions {
  /** Where dependency-cruiser runs; reported paths are relative to it. */
  readonly rootDir: string;
  readonly games: readonly LoadedGame[];
  /** The version of `@your-move/sdk` this instance builds with. */
  readonly sdkVersion: string;
  /** The SDK package's directory as installed here (symlinks resolved). */
  readonly sdkDir: string;
  /** This repository's workspace packages (real paths): see ./workspace.ts. */
  readonly workspaceDirs: ReadonlySet<string>;
  /**
   * The test kit's mode. `pnpm games:verify` always runs the kit; only tests of the package and
   * import rules, whose fixture packages have no real engines, leave it out.
   */
  readonly kit?: KitMode;
  /** Receives every package file the checks covered (absolute paths). */
  readonly checked?: Set<string>;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");

/** Type ids must be valid and unique across the instance. */
export function checkIdentity(games: readonly LoadedGame[]): string[] {
  const problems: string[] = [];
  const owners = new Map<string, string>();
  for (const game of games) {
    const { type } = game.manifest;
    if (!isGameType(type)) {
      problems.push(
        `${game.packageName}: type "${type}" must match ^[a-z][a-z0-9]{1,31}$ (02 §7.2)`,
      );
      continue;
    }
    const owner = owners.get(type);
    if (owner === undefined) {
      owners.set(type, game.packageName);
    } else {
      problems.push(
        `${game.packageName}: type "${type}" is already declared by ${owner} (02 §7.3)`,
      );
    }
  }
  return problems;
}

/**
 * Resolves pnpm's `workspace:` protocol the way publishing does, so a first-party game in this
 * repository is checked exactly like its published package: `workspace:^` and `workspace:~`
 * become `^`/`~` of the workspace version, `workspace:*` the version itself, and
 * `workspace:<range>` the range. Only for workspace packages: see `checkWorkspaceRanges`.
 */
export function resolveWorkspaceRange(range: string, workspaceVersion: string): string {
  if (!range.startsWith("workspace:")) return range;
  const spec = range.slice("workspace:".length);
  if (spec === "^" || spec === "~") return `${spec}${workspaceVersion}`;
  if (spec === "*") return workspaceVersion;
  return spec;
}

/**
 * A package installed from a registry was published, and publishing replaces every `workspace:`
 * range; one that still has them didn't come through `pnpm publish` and can't be checked.
 */
function checkWorkspaceRanges(game: LoadedGame): string[] {
  const { dependencies, peerDependencies } = game.pkg;
  return Object.entries({ ...dependencies, ...peerDependencies })
    .filter(([, range]) => range.startsWith("workspace:"))
    .map(
      ([dependency, range]) =>
        `${game.packageName}: ${dependency} "${range}" uses the workspace: protocol, but the package isn't in this workspace; a published package can't have it`,
    );
}

/** The package's `@your-move/sdk` peer range must include this instance's SDK (02 §7.4). */
function checkSdk(game: LoadedGame, sdkVersion: string, workspace: boolean): string[] {
  const declared = game.pkg.peerDependencies["@your-move/sdk"];
  // In this repository the workspace SDK is the instance's SDK.
  const range =
    declared !== undefined && workspace ? resolveWorkspaceRange(declared, sdkVersion) : declared;
  if (range === undefined) {
    return [`${game.packageName}: must declare @your-move/sdk as a peer dependency (02 §7.1.1)`];
  }
  if (validRange(range) === null) {
    return [`${game.packageName}: @your-move/sdk peer range "${range}" is not a semver range`];
  }
  if (!satisfies(sdkVersion, range, { includePrerelease: true })) {
    return [
      `${game.packageName}: @your-move/sdk peer range "${range}" does not include this instance's SDK ${sdkVersion}`,
    ];
  }
  return [];
}

/** The licence must match package.json and be allow-listed or explicitly accepted. */
function checkLicence(game: LoadedGame): string[] {
  const { licence } = game.manifest;
  const problems: string[] = [];
  if (game.pkg.license !== licence) {
    problems.push(
      `${game.packageName}: manifest licence "${licence}" differs from package.json "${game.pkg.license ?? "(none)"}" (02 §7.2)`,
    );
  }
  if (!isAllowedExpression(licence) && game.acceptLicence !== licence) {
    problems.push(
      `${game.packageName}: licence "${licence}" is not on the allow-list (11 §6); accept it explicitly with acceptLicence: "${licence}" in instance.config.ts`,
    );
  }
  return problems;
}

/**
 * The dependency rules of 02 §7.1.1: the SDK, Zod and React are peers only, never dependencies,
 * and nothing else is a peer. Any other `dependencies` are for the client alone; the import
 * ruleset keeps the engine and manifest away from them.
 */
function checkDependencies(game: LoadedGame): string[] {
  const problems: string[] = [];
  const suppliedByInstance = Object.keys(game.pkg.dependencies).filter((name) =>
    ALLOWED_PEERS.has(name),
  );
  if (suppliedByInstance.length > 0) {
    problems.push(
      `${game.packageName}: ${suppliedByInstance.join(", ")} must be peer dependencies, not dependencies (02 §7.1.1)`,
    );
  }
  const peers = Object.keys(game.pkg.peerDependencies).filter((peer) => !ALLOWED_PEERS.has(peer));
  if (peers.length > 0) {
    problems.push(
      `${game.packageName}: peer dependencies may only be ${[...ALLOWED_PEERS].join(", ")}; found ${peers.join(", ")}`,
    );
  }
  return problems;
}

/** What the import check found: its problems, and the package's own files it visited. */
interface ImportCheck {
  readonly problems: string[];
  /** Every file of the package reachable from its three entry points (absolute paths). */
  readonly files: readonly string[];
  /** The files reachable from the engine and manifest entry points: the ESLint rules' scope. */
  readonly engineFiles: readonly string[];
}

/** Runs the testkit's import ruleset (02 §7.5) over the files the package's `exports` names. */
async function checkImports(
  game: LoadedGame,
  rootDir: string,
  sdkDir: string,
): Promise<ImportCheck> {
  const rel = (file: string): string => relative(rootDir, file);
  const exact = (file: string): string => `^${escapeRegExp(rel(file))}$`;
  const ownDir = escapeRegExp(rel(game.pkg.dir));
  const { entries } = game.pkg;
  const result = await cruise([rel(entries.engine), rel(entries.client), rel(entries.manifest)], {
    baseDir: rootDir,
    validate: true,
    tsPreCompilationDeps: true,
    ruleSet: {
      forbidden: gamePackageRules({
        engineEntry: exact(entries.engine),
        clientEntry: exact(entries.client),
        manifestEntry: exact(entries.manifest),
        ownFiles: `^${ownDir}/`,
        sdk: `(^|/)${escapeRegExp(rel(sdkDir))}/`,
        clientDependencies: Object.keys(game.pkg.dependencies),
      }),
    },
    // Follow the package's own files only: any other module is judged by where it is, not by
    // what it imports in turn (a client dependency's own dependencies are its business).
    doNotFollow: { path: `^(?!${ownDir}/)` },
    // Resolve through package.json "exports" the way Node and bundlers do.
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "default"],
    },
  });
  const output = result.output as ICruiseResult;
  const problems = output.summary.violations.map(
    (violation) =>
      `${game.packageName}: ${violation.rule.name}: ${violation.from} must not reach ${violation.to}`,
  );
  // The package's own modules and the edges between them, to find what each entry reaches.
  const own = (source: string): boolean =>
    resolve(rootDir, source).startsWith(`${game.pkg.dir}${sep}`);
  const edges = new Map(
    output.modules
      .filter((module) => own(module.source))
      .map((module) => [
        module.source,
        module.dependencies.map((dependency) => dependency.resolved).filter(own),
      ]),
  );
  const reach = (entries: readonly string[]): string[] => {
    const seen = new Set<string>();
    const queue = entries.map((entry) => rel(entry));
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      if (seen.has(next) || !edges.has(next)) continue;
      seen.add(next);
      queue.push(...(edges.get(next) ?? []));
    }
    return [...seen].map((source) => resolve(rootDir, source)).sort();
  };
  return {
    problems,
    files: reach([entries.engine, entries.client, entries.manifest]),
    engineFiles: reach([entries.engine, entries.manifest]),
  };
}

/**
 * The engine ESLint rules (02 §7.5: globals allow-list, no writes to built-ins) on the built
 * engine and manifest output: exactly the files Node and the bundlers load.
 */
async function checkEngineLint(
  game: LoadedGame,
  rootDir: string,
  files: readonly string[],
): Promise<string[]> {
  if (files.length === 0) return [];
  const relativeFiles = files.map((file) => relative(rootDir, file));
  const eslint = new ESLint({
    cwd: rootDir,
    // Installed packages live under node_modules, which ESLint ignores by default.
    ignore: false,
    overrideConfigFile: true,
    overrideConfig: [
      { languageOptions: { ecmaVersion: 2023, sourceType: "module" } },
      ...engineEslintConfig(relativeFiles),
    ],
  });
  const results = await eslint.lintFiles(relativeFiles);
  return results.flatMap((result) =>
    result.messages.map(
      (message) =>
        `${game.packageName}: ${relative(rootDir, result.filePath)}:${String(message.line)}: ${message.message} (${message.ruleId ?? "parse"})`,
    ),
  );
}

/** The generic test kit (02 §6) and the manifest-versus-engine check (02 §7.2), icon included. */
function checkKit(game: LoadedGame, mode: KitMode): string[] {
  try {
    const report = runKit(game.engines, { mode, manifest: game.manifest });
    return report.failures.map(
      (failure) =>
        `${game.packageName}: kit ${failure.property}${failure.version === undefined ? "" : ` (rules version ${String(failure.version)}${failure.seats === undefined ? "" : `, ${String(failure.seats)} seats`}${failure.seed === undefined ? "" : `, seed ${String(failure.seed)}`})`}: ${failure.message}`,
    );
  } catch (error) {
    return [
      `${game.packageName}: the test kit couldn't run its engines: ${error instanceof Error ? error.name : "error"}`,
    ];
  }
}

/**
 * Every problem with the installed games; empty when the instance may be built. The files each
 * package's checks covered are added to `options.checked`, for the bundler-input check that runs
 * after the builds (10 M1).
 */
export async function verifyGames(options: VerifyOptions): Promise<string[]> {
  const problems = checkIdentity(options.games);
  for (const game of options.games) {
    const workspace = options.workspaceDirs.has(game.pkg.dir);
    const imports = await checkImports(game, options.rootDir, options.sdkDir);
    problems.push(
      ...(workspace ? [] : checkWorkspaceRanges(game)),
      ...packageFileProblems(
        game.packageName,
        game.pkg.dir,
        workspace,
        workspace ? packedFiles(game.pkg.dir) : undefined,
      ),
      ...checkSdk(game, options.sdkVersion, workspace),
      ...checkLicence(game),
      ...checkDependencies(game),
      ...imports.problems,
      ...(await checkEngineLint(game, options.rootDir, imports.engineFiles)),
      ...(options.kit === undefined ? [] : checkKit(game, options.kit)),
    );
    for (const file of imports.files) options.checked?.add(file);
  }
  return problems;
}
