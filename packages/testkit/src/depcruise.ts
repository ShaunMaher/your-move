/**
 * The import rules every game package must pass (docs/spec/02-game-framework.md §7.1.1, §7.5;
 * 11-engineering.md §5), as dependency-cruiser rules. The same rules run in a game's own
 * repository, in this repository's `pnpm lint:arch`, and in `pnpm games:verify` against the files
 * each installed package's `exports` map points at.
 *
 * This module is loaded directly by Node (dependency-cruiser configs are plain JavaScript), so it
 * uses erasable TypeScript syntax only and imports nothing at runtime.
 *
 * @packageDocumentation
 */
import type { IForbiddenRuleType, IReachabilityForbiddenRuleType } from "dependency-cruiser";

/**
 * Where a game package's code lives, as dependency-cruiser path regular expressions (matched
 * against paths relative to the directory dependency-cruiser runs in).
 *
 * @public
 */
export interface GamePackageLayout {
  /** Matches the engine entry module(s), e.g. `^dist/engine/index\\.js$`. */
  readonly engineEntry: string;
  /** Matches the client entry module(s). */
  readonly clientEntry: string;
  /** Matches the manifest entry module(s). */
  readonly manifestEntry: string;
  /**
   * Matches the package's own files, e.g. `^dist/`. May use capture groups from the entry
   * patterns as `$1` (dependency-cruiser group matching), so one rule can cover `games/<id>/`.
   */
  readonly ownFiles: string;
  /**
   * Matches the SDK package's root directory as it resolves here, ending in `/`. Defaults to the
   * installed package (`node_modules/@your-move/sdk/`); a monorepo that links the SDK from source
   * passes its path instead.
   */
  readonly sdk?: string;
  /** The package's own `dependencies`, which only its client may import (02 §7.1.1). */
  readonly clientDependencies?: readonly string[];
}

const installed = (name: string): string =>
  `(^|/)node_modules/${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/`;

/**
 * Builds the forbidden rules for one game package layout.
 *
 * - An engine or manifest may reach only the SDK (never `@your-move/sdk/client`), Zod through
 *   `@your-move/sdk/schema`, and the package's own files: no `node:*` or other built-in modules, no
 *   runtime or framework packages, no React or DOM libraries.
 * - A client may reach only the SDK (including `/client`), Zod through the SDK, React, the
 *   package's own files (its engine included) and the packages in its own `dependencies`.
 * - No file of the package imports Zod directly: only through `@your-move/sdk/schema`.
 *
 * The import rules are reachability rules, so a forbidden import is caught however deep it is.
 *
 * @public
 */
export function gamePackageRules(layout: GamePackageLayout): IForbiddenRuleType[] {
  const sdk = layout.sdk ?? installed("@your-move/sdk");
  // Group references ($1) only work in `to`; as a `from` they stand for any one path segment.
  const anyOwnFile = layout.ownFiles.replaceAll("$1", "[^/]+");
  const zod = installed("zod");
  const pure = [layout.ownFiles, sdk, zod];
  const sdkClient = `${sdk}(src|dist)/client[.]`;
  return [
    ...(
      [
        ["engine", layout.engineEntry],
        ["manifest", layout.manifestEntry],
      ] as const
    ).flatMap(([part, entry]): IReachabilityForbiddenRuleType[] => [
      {
        name: `game-${part}-imports`,
        comment: `A game ${part} may import only @your-move/sdk, @your-move/sdk/schema and its own files (02 §7.1.1, §7.5).`,
        severity: "error",
        from: { path: entry },
        to: { reachable: true, pathNot: pure },
      },
      {
        name: `game-${part}-no-sdk-client`,
        comment: `A game ${part} must not import @your-move/sdk/client, which may bring in React.`,
        severity: "error",
        from: { path: entry },
        to: { reachable: true, path: sdkClient },
      },
    ]),
    {
      name: "game-client-imports",
      comment:
        "A game client may import only @your-move/sdk, React, its own files and its own dependencies (02 §7.1.1).",
      severity: "error",
      from: { path: layout.clientEntry },
      to: {
        reachable: true,
        pathNot: [...pure, installed("react"), ...(layout.clientDependencies ?? []).map(installed)],
      },
    },
    {
      name: "game-no-direct-zod",
      comment: "Game code imports Zod only through @your-move/sdk/schema (02 §7.1.1, §7.5).",
      severity: "error",
      from: { path: anyOwnFile },
      to: { path: zod },
    },
  ];
}
