/**
 * The generic test kit's public types (docs/spec/02-game-framework.md §6).
 */
import type { GameManifest, OptionsContext, Resources } from "@your-move/sdk";

/**
 * `fast`: a few hundred games per package (`pnpm games:verify --fast`); `full`: a thousand games per
 * option set and seat count (CI's test stage and each game package's own CI), 02 §6.
 *
 * @public
 */
export type KitMode = "fast" | "full";

/**
 * The kit's checks (02 §6), plus the manifest check of 02 §7.2.
 *
 * @public
 */
export type KitProperty =
  "schema" | "replay" | "secrecy" | "termination" | "turns" | "cpu" | "isolation" | "manifest";

/**
 * One failed check.
 *
 * @public
 */
export interface KitFailure {
  readonly property: KitProperty;
  readonly message: string;
  /** The rules version it failed on. */
  readonly version?: number;
  /** The seat count of the failing game. */
  readonly seats?: number;
  /** The seed that reproduces the failing game. */
  readonly seed?: number;
}

/**
 * How to run the kit.
 *
 * @public
 */
export interface KitOptions {
  readonly mode: KitMode;
  /** The package's manifest: when given, it must agree with every engine (02 §7.2). */
  readonly manifest?: GameManifest;
  /** Option inputs to resolve and play, each with every allowed seat count. Default `[{}]`. */
  readonly optionInputs?: readonly unknown[];
  /** What `resolveOptions` and `catalog` see. Default: `configSchema` parsed from `{}`, no resources. */
  readonly context?: OptionsContext;
  /** Resources passed to `validate` and `preview` while playing (replay always uses none). */
  readonly resources?: Resources;
  /** The first seed; game `n` uses `seed + n`. Default 1. */
  readonly seed?: number;
  /** Games per option set and seat count, overriding the mode's number. */
  readonly games?: number;
  /** Per-call CPU budget in milliseconds for `worstCase` inputs (08 T25). Default 5. */
  readonly cpuBudgetMs?: number;
}

/**
 * What the kit found.
 *
 * @public
 */
export interface KitReport {
  readonly failures: readonly KitFailure[];
  /** How many games were played. */
  readonly games: number;
}
