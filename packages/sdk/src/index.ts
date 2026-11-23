/**
 * The game SDK: the versioned contract between the framework and every game package
 * (docs/spec/02-game-framework.md §2, §3, §7).
 *
 * M0 ships only the manifest shape and the type-id rule, which instance composition
 * (`pnpm games:generate` / `pnpm games:verify`) needs; `/schema` re-exports Zod and `/client` is a
 * placeholder. `GameDefinition`, `GameClientModule`, `RandomSource` and `Resources` arrive in M1.
 *
 * @packageDocumentation
 */

/**
 * The pattern every game type id must match (02 §7.2). The type id is stored in rows as
 * `game_type` and used in `ENABLED_GAMES` and `GAMES_<TYPE>_*` configuration.
 *
 * @public
 */
export const GAME_TYPE_PATTERN = /^[a-z][a-z0-9]{1,31}$/;

/**
 * Whether `value` is a valid game type id (02 §7.2).
 *
 * @public
 */
export function isGameType(value: string): boolean {
  return GAME_TYPE_PATTERN.test(value);
}

/**
 * Framework resource kinds a game engine may request (02 §2.1 rule 7). Dictionaries are the only
 * kind in v1 (03 §10).
 *
 * @public
 */
export type ResourceKind = "dictionary";

/**
 * A game package's metadata, exported from its `/manifest` entry point as `manifest` (02 §7.2).
 * SDK compatibility is stated by the package's `@your-move/sdk` peer range, not here.
 *
 * @public
 */
export interface GameManifest {
  /** `^[a-z][a-z0-9]{1,31}$`, unique within an instance; the `game_type` stored in rows. */
  readonly type: string;
  /** Neutral display name, e.g. "Words". No trademarks. */
  readonly name: string;
  /** One line for the new-game picker. */
  readonly description: string;
  /** SVG markup of original artwork; sanitised at build (no scripts, no external references). */
  readonly icon: string;
  /** SPDX licence id; must equal the package's `package.json` `license`. */
  readonly licence: string;
  /** Framework resource kinds the engine may request. */
  readonly resources: readonly ResourceKind[];
  /** Whether any seat's view hides information from others, declared up front for the catalog. */
  readonly hiddenInformation: boolean;
  /** Overall player-count bounds across all options. */
  readonly players: { readonly min: number; readonly max: number };
  /** The rules as Markdown (no HTML), per rules version. */
  readonly rules: Readonly<Record<number, string>>;
  /** Source repository or documentation. */
  readonly homepage?: string;
}
