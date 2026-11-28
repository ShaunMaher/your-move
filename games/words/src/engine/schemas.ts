/**
 * The words game's constants, schemas and the types inferred from them
 * (docs/spec/games/words.md §10, docs/spec/02-game-framework.md §2). Every value that crosses the
 * contract (options, actions, views, records, previews, the catalog, the module config) has one
 * Zod schema here, built with the Zod that `@your-move/sdk/schema` re-exports (02 §7.1.1).
 */
import { z } from "@your-move/sdk/schema";

import { MAX_BOARD_SIZE, SWAP_ORDERS } from "./rulesets/schema.js";

/** The game type id; matches the manifest (02 §7.2). */
export const GAME_TYPE = "words";

/** The default turn timeout for this module, in days (words §5, §10.1). */
export const DEFAULT_TURN_TIMEOUT_DAYS = 14;

/** Instance defaults when the module config doesn't set them (09 §1). */
export const DEFAULT_RULESET = "classic";
export const DEFAULT_DICTIONARY = "enable";

/** How a finished game ended (words §5, §10.4, §10.6). */
const END_REASONS = ["out", "scoreless", "resign", "timeout", "decline"] as const;
export type EndReason = (typeof END_REASONS)[number];

const count = z.number().int().min(0);
const integer = z.number().int();
const version = z.number().int().min(1);
const seat = count;
const square = z
  .number()
  .int()
  .min(0)
  .max(MAX_BOARD_SIZE - 1);
/** A tile code: `a`–`z`, or `?` for a blank (words §3.1). */
const tileCode = z.string().regex(/^[a-z?]$/u);
/** A letter a blank stands for, or a placed tile's letter. */
const letter = z.string().regex(/^[a-z]$/u);

/** Resolved options (words §10.1): every field present. */
export const optionsSchema = z
  .object({
    rulesetId: z.string().min(1),
    rulesetVersion: version,
    dictionaryId: z.string().min(1),
    dictionaryVersion: version,
  })
  .strict();
export type Options = z.infer<typeof optionsSchema>;

const placementSchema = z
  .object({ row: square, col: square, tile: tileCode, letter: letter.optional() })
  .strict();
export type Placement = z.infer<typeof placementSchema>;

/** The actions (words §10.3). Resign is a framework action that calls `onResign`. */
export const actionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("play"),
      placements: z.array(placementSchema).min(1).max(MAX_BOARD_SIZE),
    })
    .strict(),
  z
    .object({ type: z.literal("swap"), tiles: z.array(tileCode).min(1).max(MAX_BOARD_SIZE) })
    .strict(),
  z.object({ type: z.literal("pass") }).strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export type PlayAction = Extract<Action, { type: "play" }>;
export type SwapAction = Extract<Action, { type: "swap" }>;

/** One word formed by a play, with its score (words §4). */
const scoredWordSchema = z.object({ word: z.string().regex(/^[a-z]+$/u), score: count }).strict();
export type ScoredWord = z.infer<typeof scoredWordSchema>;

/**
 * Public records (words §10.4, 02 §2.1 rule 5): the placed tiles and the words they formed are
 * public (they are on the board); a swap shows only how many tiles were swapped, never which.
 */
export const recordSchema = z.discriminatedUnion("type", [
  z
    .object({
      seat,
      type: z.literal("play"),
      placements: z
        .array(z.object({ row: square, col: square, tile: tileCode, letter }).strict())
        .min(1),
      /** Main word first; at least one (words §3.1 rule 6). */
      words: z.array(scoredWordSchema).min(1),
      score: count,
      bingo: z.boolean(),
    })
    .strict(),
  z
    .object({
      seat,
      type: z.literal("swap"),
      score: z.literal(0),
      bingo: z.literal(false),
      swapCount: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      seat,
      type: z.enum(["pass", "resign", "timeout", "decline"]),
      score: z.literal(0),
      bingo: z.literal(false),
    })
    .strict(),
]);
export type PublicRecord = z.infer<typeof recordSchema>;

/** One square of the board as a view shows it: a blank shows the letter it stands for. */
const boardSquareSchema = z
  .object({ tile: tileCode, letter, blank: z.boolean() })
  .strict()
  .nullable();

/** A seat's or the public view (words §10.4). */
export const viewSchema = z
  .object({
    ruleset: z.object({ id: z.string(), version }).strict(),
    dictionary: z.object({ id: z.string(), version }).strict(),
    board: z.array(z.array(boardSquareSchema)),
    /** Every seat's score; final scores (adjustments included) once the game is over. */
    scores: z.array(integer),
    rackCounts: z.array(count),
    bagCount: count,
    /** The viewer's own rack, sorted; null in the public view. */
    yourRack: z.array(tileCode).nullable(),
    /** The record of the last transition, so every public move shows in the view (02 §6.3). */
    lastMove: recordSchema.nullable(),
    final: z
      .object({
        reason: z.enum(END_REASONS),
        adjustments: z.array(integer),
        /** Every seat's last rack, sorted: never the order the tiles were drawn in (words §7). */
        racks: z.array(z.array(tileCode)),
      })
      .strict()
      .optional(),
  })
  .strict();
export type View = z.infer<typeof viewSchema>;

/** What a play would score (words §10.5); swaps and passes preview as scoring nothing. */
export const previewSchema = z
  .object({ score: count, words: z.array(scoredWordSchema), bingo: z.boolean() })
  .strict();
export type PreviewResult = z.infer<typeof previewSchema>;

/** One ruleset as the new-game form shows it (words §10.1). */
const catalogRulesetSchema = z
  .object({
    id: z.string(),
    version,
    name: z.string(),
    description: z.string(),
    language: z.string(),
    boardSize: count,
    rackSize: count,
    tileCount: count,
    bingoBonus: count,
    swapOrder: z.enum(SWAP_ORDERS),
    swapMinBag: count,
    scorelessTurnLimit: count,
    players: z.object({ min: count, max: count }).strict(),
    /** The premium picture, one string per row (words §8.1). */
    premiums: z.array(z.string()),
  })
  .strict();

/** One dictionary the creator may choose, with the rulesets it can be played with (words §9.3). */
const catalogDictionarySchema = z
  .object({
    id: z.string(),
    version,
    name: z.string(),
    language: z.string(),
    distribution: z.enum(["public", "serverOnly"]),
    source: z.enum(["builtin", "operator", "upload"]),
    compatibleRulesets: z.array(z.string()),
  })
  .strict();

/** This module's part of `GET /api/v1/catalog` (words §10.1). */
export const catalogSchema = z
  .object({
    rulesets: z.array(catalogRulesetSchema),
    dictionaries: z.array(catalogDictionarySchema),
    defaults: z
      .object({ rulesetId: z.string().nullable(), dictionaryId: z.string().nullable() })
      .strict(),
  })
  .strict();
export type Catalog = z.infer<typeof catalogSchema>;

/**
 * The module config: the `GAMES_WORDS_*` keys with the prefix stripped (02 §2.1 rule 8, 09 §1).
 * `ENABLED_RULESETS` is a comma-separated list of ruleset ids. Which ids exist, and whether the
 * defaults are enabled and compatible, is checked by `checkConfig`.
 */
export const configSchema = z
  .object({
    ENABLED_RULESETS: z.string().optional(),
    DEFAULT_RULESET: z.string().optional(),
    DEFAULT_DICTIONARY: z.string().optional(),
  })
  .strict();

/** Every code the module returns (words §10.3); none is reserved (02 §2.2). */
export const ERROR_CODES = {
  /** A play breaks a placement rule; `detail` names which (words §10.3). */
  invalidPlacement: "INVALID_PLACEMENT",
  /** A play forms words that aren't in the dictionary; `detail: { words }`. */
  invalidWords: "INVALID_WORDS",
  /** A swap isn't allowed; `detail` says why: `BAG_TOO_SMALL` or `TILE_NOT_IN_RACK`. */
  swapNotAllowed: "SWAP_NOT_ALLOWED",
  /** `validate`/`preview` for a seat that isn't to act (the framework never asks for one). */
  notToAct: "NOT_TO_ACT",
  /** `resolveOptions`/`checkConfig`: the ruleset doesn't exist or isn't enabled. */
  unknownRuleset: "UNKNOWN_RULESET",
  /** `resolveOptions`/`checkConfig`: the dictionary isn't one the creator may use. */
  unknownDictionary: "UNKNOWN_DICTIONARY",
  /** `resolveOptions`/`checkConfig`: the dictionary can't be played with the ruleset (words §9.3). */
  incompatibleDictionary: "INCOMPATIBLE_DICTIONARY",
  /** `validateStart`: too few tiles to fill every rack. */
  notEnoughTiles: "NOT_ENOUGH_TILES",
  /** `resolveOptions`: the input isn't an object. */
  optionsNotObject: "OPTIONS_NOT_OBJECT",
  /** `resolveOptions`: a key that isn't an option. */
  unknownOption: "UNKNOWN_OPTION",
  /** `resolveOptions`: a version key whose value isn't a non-negative integer. */
  invalidOption: "INVALID_OPTION",
} as const;

/** The `detail` of an `INVALID_PLACEMENT` error, in check order (words §10.3). */
export type PlacementError =
  | "TOO_MANY_TILES"
  | "OUT_OF_BOUNDS"
  | "DUPLICATE_SQUARE"
  | "SQUARE_OCCUPIED"
  | "BLANK_NEEDS_LETTER"
  | "LETTER_ON_NON_BLANK"
  | "TILE_NOT_IN_RACK"
  | "NOT_IN_LINE"
  | "GAP"
  | "TOO_FEW_TILES"
  | "START_NOT_COVERED"
  | "NOT_CONNECTED"
  | "NO_WORD_FORMED";
