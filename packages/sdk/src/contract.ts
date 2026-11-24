/**
 * The game module contract, server / engine side (docs/spec/02-game-framework.md §2).
 */
import type { z } from "zod";

import type { RandomSource } from "./random.js";

/**
 * A Zod schema for `T` (02 §2). Build it with `@your-move/sdk/schema`.
 *
 * @public
 */
export type Schema<T> = z.ZodType<T>;

/**
 * A seat number, `0 .. seats - 1`, fixed at start; seat order is turn order (02 §4).
 *
 * @public
 */
export type Seat = number;

/**
 * A module error: one of the module's `errorCodes`, never a reserved code (02 §2.1 rule 3, §2.2).
 *
 * @public
 */
export interface GameError {
  readonly code: string;
  readonly detail?: unknown;
}

/**
 * The success value of `validate`, `validateStart` and `checkConfig`.
 *
 * @public
 */
export interface Ok {
  readonly ok: true;
}

/**
 * The one {@link Ok} value.
 *
 * @public
 */
export const OK: Ok = Object.freeze({ ok: true });

/**
 * Display text: strings and seat placeholders, filled with current names when shown (02 §5).
 *
 * @public
 */
export type Text = readonly (string | { readonly seat: Seat })[];

/**
 * A module's parsed `GAMES_<TYPE>_*` configuration (02 §2.1 rule 8).
 *
 * @public
 */
export type ModuleConfig = unknown;

/**
 * Framework resource kinds a game engine may request (02 §2.1 rule 7). Dictionaries are the only
 * kind in v1.
 *
 * @public
 */
export type ResourceKind = "dictionary";

/**
 * A resource an engine needs for a game, e.g. a dictionary (02 §2.1 rule 7).
 *
 * @public
 */
export interface ResourceRequest {
  readonly kind: ResourceKind;
  readonly id: string;
  readonly version?: number;
}

/**
 * Metadata of one resource, never its contents (02 §2, 08 T22).
 *
 * @public
 */
export interface ResourceMeta {
  readonly kind: ResourceKind;
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly language: string;
  readonly alphabet: readonly string[];
  readonly distribution: "public" | "serverOnly";
  readonly source: "builtin" | "operator" | "upload";
  /** Set by the framework for public distribution only. */
  readonly downloadUrl?: string;
}

/**
 * Metadata of the resources a creator may use, or (for `checkConfig`) every enabled built-in and
 * operator resource (02 §2).
 *
 * @public
 */
export type ResourceCatalog = readonly ResourceMeta[];

/**
 * Resources loaded for one game, as synchronous lookups (02 §2.1 rule 6). Only `validate` and
 * `preview` receive them.
 *
 * @public
 */
export interface Resources {
  readonly dictionary?: {
    readonly id: string;
    readonly version: number;
    has(word: string): boolean;
  };
}

/**
 * Why a seat leaves through `onResign` (02 §2.1 rule 9).
 *
 * @public
 */
export type ExitReason = "resign" | "decline";

/**
 * One line in the game list (02 §2).
 *
 * @public
 */
export interface ListSummary {
  readonly headline: Text;
  readonly scores?: readonly number[];
}

/**
 * What `resolveOptions` and `catalog` see (02 §2).
 *
 * @public
 */
export interface OptionsContext {
  /** The parsed `configSchema` value. */
  readonly config: ModuleConfig;
  /** Metadata of the resources this creator may use, already filtered by the framework. */
  readonly resources: ResourceCatalog;
}

/**
 * A seat's place in the final ranking: standard competition ranking (02 §4).
 *
 * @public
 */
export interface RankingEntry {
  readonly seat: Seat;
  readonly rank: number;
  readonly score?: number;
}

/**
 * The result of a finished game (02 §2).
 *
 * @public
 */
export interface GameResult {
  readonly ranking: readonly RankingEntry[];
  /** Module-defined, e.g. "out", "last-standing". */
  readonly endReason: string;
}

/**
 * A module transition's outcome: the new state and its public record (02 §2.1 rule 5).
 *
 * @public
 */
export interface Transition<State, PublicRecord> {
  readonly state: State;
  readonly record: PublicRecord;
}

/**
 * One `worstCase` input for the CPU budget check (02 §6.6).
 *
 * @public
 */
export interface WorstCase<State, Action> {
  readonly state: State;
  readonly seat: Seat;
  readonly action: Action;
}

/**
 * The hooks the generic test kit drives a module with (02 §6).
 *
 * @public
 */
export interface GameTestHooks<Options, State, Action> {
  /** An action for `seat` that MUST validate. */
  randomAction(state: State, seat: Seat, rng: RandomSource, res: Resources): Action;
  /** A schema-valid action, often illegal, biased to near-legal. */
  randomAnyAction(state: State, seat: Seat, rng: RandomSource): Action;
  /**
   * Randomises everything `viewer` can't see while keeping the state consistent; `null` means
   * everything hidden from the public view.
   */
  perturbHidden(state: State, viewer: Seat | null, rng: RandomSource): State;
  /** Whether the game has any hidden information (hands, deck order, secret actions). */
  readonly hiddenInformation: boolean;
  /** Termination bound for random play. */
  maxActions(options: Options, seats: number): number;
  /** The most expensive inputs for `validate` + `apply` (and `preview`). */
  worstCase(
    options: Options,
    seats: number,
    rng: RandomSource,
  ): readonly WorstCase<State, Action>[];
  /** Whether records legitimately show random draws (e.g. dice). */
  readonly publicRandomness?: boolean;
  /**
   * True if no seat ever sees the hidden information (e.g. only the deck order is hidden): the
   * kit's non-vacuity check then counts perturbations that change the state, rather than ones that
   * change another viewer's view (02 §6.3). Never set it for a game with hidden hands.
   */
  readonly hiddenFromEveryone?: boolean;
  /**
   * The option inputs the kit plays, each with every seat count `players` and `validateStart`
   * allow (02 §6). Required and non-empty: list the defaults (`{}`) and enough other inputs to
   * reach every rule an option changes (rulesets, variants, the corners of each range).
   */
  optionInputs(ctx: OptionsContext): readonly unknown[];
  /**
   * What `resolveOptions`, `catalog` and `checkConfig` see in the kit. Default: `configSchema`
   * parsed from `{}`, and no resources.
   */
  context?(): OptionsContext;
  /** The resources `validate` and `preview` get in a game with these options. Default: none. */
  resources?(options: Options): Resources;
}

/**
 * One rules version of a game engine (02 §2). A package's `/engine` entry point exports one per
 * supported rules version as `engines` (02 §7.1).
 *
 * @public
 */
export interface GameDefinition<
  Options = unknown,
  State = unknown,
  Action = unknown,
  View = unknown,
  PublicRecord = unknown,
  PreviewResult = never,
> {
  /** The game type id, matching the manifest. */
  readonly type: string;
  /** The rules version; bump on any rule or state-shape change (02 §7.4). */
  readonly version: number;

  readonly configSchema: Schema<ModuleConfig>;
  readonly optionsSchema: Schema<Options>;
  readonly actionSchema: Schema<Action>;
  readonly viewSchema: Schema<View>;
  readonly recordSchema: Schema<PublicRecord>;
  readonly previewSchema?: Schema<PreviewResult>;
  readonly catalogSchema: Schema<unknown>;
  /** Every code `validate`, `preview`, `resolveOptions`, `validateStart` and `checkConfig` return. */
  readonly errorCodes: readonly string[];

  resolveOptions(input: unknown, ctx: OptionsContext): Options | GameError;
  catalog(ctx: OptionsContext): unknown;
  players(options: Options): { readonly min: number; readonly max: number };
  validateStart(options: Options, seats: number): Ok | GameError;
  defaultTurnTimeoutDays(options: Options): number;
  resources(options: Options): readonly ResourceRequest[];
  checkConfig(config: ModuleConfig, catalog: ResourceCatalog): Ok | GameError;

  setup(ctx: {
    readonly options: Options;
    readonly seats: number;
    readonly rng: RandomSource;
  }): State;
  toAct(state: State): Seat[];
  seatStatus(state: State): ("playing" | "out")[];
  validate(state: State, seat: Seat, action: Action, res: Resources): Ok | GameError;
  apply(
    state: State,
    seat: Seat,
    action: Action,
    rng: RandomSource,
  ): Transition<State, PublicRecord>;
  onResign(
    state: State,
    seat: Seat,
    rng: RandomSource,
    reason: ExitReason,
  ): Transition<State, PublicRecord>;
  onTimeout(state: State, seat: Seat, rng: RandomSource): Transition<State, PublicRecord>;
  result(state: State): GameResult | null;

  view(state: State, viewer: Seat | null): View;
  preview?(state: State, seat: Seat, action: Action, res: Resources): PreviewResult | GameError;
  describe(record: PublicRecord): Text;
  summary(state: State, viewer: Seat | null): ListSummary;

  readonly test: GameTestHooks<Options, State, Action>;
}

/**
 * A `GameDefinition` with its type parameters erased, as the framework and the kit hold it. The
 * contract's hooks are methods, so any definition is assignable to it.
 *
 * @public
 */
export type AnyGameDefinition = GameDefinition<
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
>;

/**
 * A package's `/engine` export: one definition per rules version (02 §7.1).
 *
 * @public
 */
export type GameEngines = Readonly<Record<number, AnyGameDefinition>>;

/**
 * Whether `value` is a {@link GameError}: an object whose only keys are a string `code` and an
 * optional `detail`. Options, `Ok` and preview results must therefore not have that shape.
 *
 * @public
 */
export function isGameError(value: unknown): value is GameError {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    "code" in value &&
    typeof value.code === "string" &&
    keys.every((key) => key === "code" || key === "detail")
  );
}

/**
 * Codes reserved by the framework (02 §2.2, 05 §Errors); a module's `errorCodes` must not use them.
 *
 * @public
 */
export const RESERVED_ERROR_CODES: readonly string[] = Object.freeze([
  "INVALID_CODE",
  "INVALID_ACTION",
  "INVALID_OPTIONS",
  "INVALID_SEAT_COUNT",
  "INVALID_TIMEOUT",
  "INVALID_INVITEES",
  "AI_SEATS_NOT_ALLOWED",
  "CANNOT_PLAY_SELF",
  "UNKNOWN_GAME",
  "INVALID_DICTIONARY",
  "BAD_REQUEST",
  "UNAUTHENTICATED",
  "BAD_ORIGIN",
  "NOT_ALLOWED",
  "ONBOARDING_REQUIRED",
  "AI_NOT_ALLOWED",
  "INSUFFICIENT_SCOPE",
  "AGENT_NOT_ALLOWED",
  "SUSPENDED",
  "NOT_FOUND",
  "STALE_GAME",
  "GAME_NOT_ACTIVE",
  "GAME_UNAVAILABLE",
  "NOT_YOUR_TURN",
  "WRONG_STATUS",
  "NOT_ENOUGH_PLAYERS",
  "INVALID_SEATS",
  "ALREADY_ACTED",
  "ALREADY_JOINED",
  "TOO_MANY_GAMES",
  "TOO_MANY_DICTIONARIES",
  "TOO_MANY_TOKENS",
  "TOO_MANY_AGENTS",
  "TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "RATE_LIMITED",
  "INTERNAL",
  "UPLOADS_FULL",
]);
