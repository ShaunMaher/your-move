/**
 * The generic test kit's public types (docs/spec/02-game-framework.md §6).
 */
import type { GameManifest, OptionsContext, Resources } from "@your-move/sdk";

/**
 * `fast`: 300 games per rules version, spread over its option inputs and seat counts
 * (`pnpm games:verify --fast`); `full`: 1000 games per option input and seat count (CI's test stage
 * and each game package's own CI), 02 §6.
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
  /** Option inputs to play, overriding the module's `test.optionInputs`. */
  readonly optionInputs?: readonly unknown[];
  /** What `resolveOptions` and `catalog` see, overriding the module's `test.context`. */
  readonly context?: OptionsContext;
  /**
   * Resources for `validate` and `preview` while playing, overriding the module's
   * `test.resources` (replay always uses none).
   */
  readonly resources?: Resources;
  /**
   * The base seed. Default 1. The kit numbers the combinations it plays (each rules version's
   * option sets and seat counts, in order) from 0; game `g` of combination `k` uses seed
   * `seed + k * 2^20 + g`, so a failure's reported seed names its game in every shard.
   */
  readonly seed?: number;
  /** Games per option set and seat count, overriding the mode's number. */
  readonly games?: number;
  /**
   * Per-call CPU budget in milliseconds for `worstCase` inputs (08 T25), measured on the host
   * running the kit. Default 5.
   */
  readonly cpuBudgetMs?: number;
  /**
   * The clock the CPU budget check reads, in milliseconds. Default `performance.now()`, a wall
   * clock, which on a busy host also counts time spent waiting for a core; where the host offers
   * CPU time, pass a CPU clock, such as Node's from `threadCpuClock()`
   * (`@your-move/testkit/cpu-clock`), so the check measures the module, not the host's load
   * (02 §6.6).
   */
  readonly cpuClock?: () => number;
  /** Stop at the first failing game instead of playing on: for tests of modules that must fail. */
  readonly stopAtFirstFailure?: boolean;
  /**
   * Play only one shard of a full-mode run's combinations (`pnpm games:verify --shard`):
   * combination `k` (numbered as for `seed`) belongs to shard `k mod count + 1`. Default: the whole
   * run. Each combination is played and judged exactly as in the whole run, with the same seeds,
   * so the shards of a run together play its games and find its failures; the checks that play no
   * game (the manifest, the static checks of 02 §6.1) run in every shard. A fast-mode run can't be
   * sharded: it judges non-vacuity (02 §6.3) over each whole rules version.
   */
  readonly shard?: KitShard;
}

/**
 * One of `count` shards of a kit run, numbered from 1 (see `KitOptions.shard`).
 *
 * @public
 */
export interface KitShard {
  readonly index: number;
  readonly count: number;
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
  /** How many option set and seat count combinations were played (in this shard). */
  readonly combos: number;
}
