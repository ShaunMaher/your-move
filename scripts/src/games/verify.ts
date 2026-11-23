/**
 * `pnpm games:verify` (docs/spec/02-game-framework.md §7.3, §7.5): the build-time checks every
 * installed game package must pass. This is the M0 subset (10 M0): type ids, the SDK peer range,
 * licences, the dependency rules of 02 §7.1.1 and the import ruleset. The test kit, the
 * manifest-versus-engine check, icon sanitisation and the built-output ESLint rules arrive in M1.
 */
import { relative } from "node:path";

import { isGameType } from "@your-move/sdk";
import { gamePackageRules } from "@your-move/testkit/depcruise";
import { cruise, type ICruiseResult } from "dependency-cruiser";
import { satisfies, validRange } from "semver";

import { isAllowedExpression } from "../licences/policy.js";
import type { LoadedGame } from "./load.js";

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

/** The package's `@your-move/sdk` peer range must include this instance's SDK (02 §7.4). */
function checkSdk(game: LoadedGame, sdkVersion: string): string[] {
  const range = game.pkg.peerDependencies["@your-move/sdk"];
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

/** Runs the testkit's import ruleset (02 §7.5) over the files the package's `exports` names. */
async function checkImports(game: LoadedGame, rootDir: string, sdkDir: string): Promise<string[]> {
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
  return output.summary.violations.map(
    (violation) =>
      `${game.packageName}: ${violation.rule.name}: ${violation.from} must not reach ${violation.to}`,
  );
}

/** Every problem with the installed games; empty when the instance may be built. */
export async function verifyGames(options: VerifyOptions): Promise<string[]> {
  const problems = checkIdentity(options.games);
  for (const game of options.games) {
    problems.push(
      ...checkSdk(game, options.sdkVersion),
      ...checkLicence(game),
      ...checkDependencies(game),
      ...(await checkImports(game, options.rootDir, options.sdkDir)),
    );
  }
  return problems;
}
