/**
 * The pairs game's constants, schemas and the types inferred from them
 * (docs/spec/games/pairs.md §1, §7, §8; docs/spec/02-game-framework.md §2). Every value that
 * crosses the contract has one Zod schema here, built with the Zod that `@your-move/sdk/schema`
 * re-exports (02 §7.1.1). Every object is strict and every number an integer (pairs §8.6).
 */
import { z } from "@your-move/sdk/schema";

import { at } from "./at.js";

/** The game type id; matches the manifest (02 §7.2). */
export const GAME_TYPE = "pairs";

/** Seat-count bounds for every grid (pairs §7). */
export const PLAYERS = Object.freeze({ min: 2, max: 6 } as const);

/** The default turn timeout (pairs §7). */
export const DEFAULT_TURN_TIMEOUT_DAYS = 3;

/** How many faces there are (ids 0–17, pairs §1). */
export const FACE_COUNT = 18;

/** The grid ids, columns × rows (pairs §1). */
export const GRID_IDS = Object.freeze(["4x4", "4x5", "5x6", "6x6"] as const);
export type GridId = (typeof GRID_IDS)[number];
export const DEFAULT_GRID = "4x5" satisfies GridId;

/** One grid: its size, its pairs and its move limit `4 × pairs²` (pairs §1, §6). */
export interface Grid {
  readonly id: GridId;
  readonly columns: number;
  readonly rows: number;
  readonly pairs: number;
  readonly moveLimit: number;
}

/** A grid of `columns × rows` cards, frozen: rules data no caller may change. */
function grid(id: GridId, columns: number, rows: number): Grid {
  const pairs = (columns * rows) / 2;
  return Object.freeze({ id, columns, rows, pairs, moveLimit: 4 * pairs * pairs });
}

const GRID_LIST: readonly [Grid, Grid, Grid, Grid] = [
  grid("4x4", 4, 4),
  grid("4x5", 4, 5),
  grid("5x6", 5, 6),
  grid("6x6", 6, 6),
];

/** The four grids, in the order of `GRID_IDS` (pairs §1); frozen, entries included. */
export const GRIDS = Object.freeze(GRID_LIST);

/** The grid an id names. */
export function gridOf(id: GridId): Grid {
  const found = GRIDS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new RangeError(`unknown grid ${id}`);
  return found;
}

const MIN_SIDE = 4;
const MAX_SIDE = 6;
const MIN_PAIRS = 8;
const MAX_PAIRS = FACE_COUNT;
/**
 * The most transitions any game has: the largest `maxActions`, `6x6` at 6 seats (pairs §8.6,
 * §8.7). A game's own bound is tighter; the engine's tests check that.
 */
const MAX_MOVES = 4 * MAX_PAIRS * MAX_PAIRS + PLAYERS.max + 1;

const seat = z
  .number()
  .int()
  .min(0)
  .max(PLAYERS.max - 1);
const faceId = z
  .number()
  .int()
  .min(0)
  .max(FACE_COUNT - 1);
const gridId = z.enum(GRID_IDS);
const side = z.number().int().min(MIN_SIDE).max(MAX_SIDE);

/** Resolved options: `{ grid }`, required (pairs §7, §8.6). */
export const optionsSchema = z.object({ grid: gridId }).strict();
export type Options = z.infer<typeof optionsSchema>;

/** The one action: turn over the card at `(row, column)`; the range is `validate`'s (pairs §8.3). */
export const actionSchema = z
  .object({ type: z.literal("flip"), row: z.number().int(), column: z.number().int() })
  .strict();
export type Action = z.infer<typeof actionSchema>;

/** Why a seat is out (pairs §8.1): the framework's `out_reason` names. */
const OUT_REASONS = ["resigned", "timed_out", "declined"] as const;
export type OutReason = (typeof OUT_REASONS)[number];

/** How a finished game ended (pairs §6). */
const END_REASONS = ["all-found", "last-standing", "move-limit"] as const;
export type EndReason = (typeof END_REASONS)[number];

/** A card in the view (pairs §8.4): a face only while it is shown, and once the game is over. */
const cardSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("down"), face: faceId.nullable(), by: z.null() }).strict(),
  z.object({ state: z.literal("up"), face: faceId, by: seat }).strict(),
  z.object({ state: z.literal("missed"), face: faceId, by: seat }).strict(),
  z.object({ state: z.literal("matched"), face: faceId, by: seat }).strict(),
]);
export type Card = z.infer<typeof cardSchema>;
export type CardState = Card["state"];

/** Whether a list of numbers is strictly ascending, so also distinct. */
const ascending = (values: readonly number[]): boolean =>
  values.every((value, i) => i === 0 || value > at(values, i - 1));

const perSeat = <T extends z.ZodType>(item: T) => z.array(item).min(PLAYERS.min).max(PLAYERS.max);

/**
 * Every viewer's view (pairs §8.4, §8.6): the same for every seat and the public. Shape-level
 * bounds only: that `cards` matches `columns × rows` and `faces` holds the grid's pairs is the
 * engine's business, which its tests check.
 */
export const viewSchema = z
  .object({
    grid: gridId,
    columns: side,
    rows: side,
    faces: z
      .array(faceId)
      .min(MIN_PAIRS)
      .max(MAX_PAIRS)
      .refine(ascending, "ascending and distinct"),
    cards: z.array(z.array(cardSchema).min(MIN_SIDE).max(MAX_SIDE)).min(MIN_SIDE).max(MAX_SIDE),
    turn: seat.nullable(),
    pairs: perSeat(z.number().int().min(0).max(MAX_PAIRS)),
    out: perSeat(z.enum(OUT_REASONS).nullable()),
    moves: z.number().int().min(0).max(MAX_MOVES),
    moveLimit: z.literal(GRIDS.map((g) => g.moveLimit)),
    endReason: z.enum(END_REASONS).nullable(),
  })
  .strict();
export type View = z.infer<typeof viewSchema>;

/**
 * Public records (pairs §8.5, 02 §2.1 rule 5): who turned a card and whether it was the turn's
 * first or second, or who left. Never a card, a face or whether a pair matched (Q31).
 */
export const recordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("flip"), seat, step: z.union([z.literal(1), z.literal(2)]) }).strict(),
  z.object({ type: z.literal("resign"), seat }).strict(),
  z.object({ type: z.literal("timeout"), seat }).strict(),
  z.object({ type: z.literal("decline"), seat }).strict(),
]);
export type PublicRecord = z.infer<typeof recordSchema>;

/** One grid of the catalog, every value pinned. */
const catalogGrid = (g: Grid) =>
  z
    .object({
      id: z.literal(g.id),
      columns: z.literal(g.columns),
      rows: z.literal(g.rows),
      pairs: z.literal(g.pairs),
      moveLimit: z.literal(g.moveLimit),
    })
    .strict();

/** This module's part of `GET /api/v1/catalog` (pairs §7): exactly the four grids. */
export const catalogSchema = z
  .object({
    grid: z
      .object({
        values: z.tuple([
          z.literal(GRIDS[0].id),
          z.literal(GRIDS[1].id),
          z.literal(GRIDS[2].id),
          z.literal(GRIDS[3].id),
        ]),
        default: z.literal(DEFAULT_GRID),
      })
      .strict(),
    grids: z.tuple([
      catalogGrid(GRIDS[0]),
      catalogGrid(GRIDS[1]),
      catalogGrid(GRIDS[2]),
      catalogGrid(GRIDS[3]),
    ]),
    faces: z.literal(FACE_COUNT),
  })
  .strict();
export type Catalog = z.infer<typeof catalogSchema>;

/** The pairs game takes no `GAMES_PAIRS_*` configuration (pairs §7). */
export const configSchema = z.object({}).strict();

/** Every code the module returns; none is reserved and none carries a detail but options' (02 §2.2, pairs §7, §8.3). */
export const ERROR_CODES = Object.freeze({
  /** `resolveOptions`: the input isn't an object. */
  optionsNotObject: "OPTIONS_NOT_OBJECT",
  /** `resolveOptions`: a key that isn't an option. */
  unknownOption: "UNKNOWN_OPTION",
  /** `resolveOptions`: a value the option doesn't allow. */
  invalidOption: "INVALID_OPTION",
  /** `validate`: the seat isn't to act, or the game is over (the framework never asks). */
  notToAct: "NOT_TO_ACT",
  /** `validate`: the row or column is off the grid. */
  outOfRange: "OUT_OF_RANGE",
  /** `validate`: the card is matched, or is the turn's first card. */
  cardFaceUp: "CARD_FACE_UP",
} as const);
