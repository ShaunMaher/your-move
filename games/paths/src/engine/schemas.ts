/**
 * The paths game's constants, schemas and the types inferred from them
 * (docs/spec/games/paths.md §6, §7; docs/spec/02-game-framework.md §2). Every value that crosses
 * the contract has one Zod schema here, built with the Zod that `@your-move/sdk/schema`
 * re-exports (02 §7.1.1).
 */
import { z } from "@your-move/sdk/schema";

import { NOTCHES } from "./geometry.js";
import { ROTATIONS, TILE_COUNT } from "./tiles.js";

/** The game type id; matches the manifest (02 §7.2). */
export const GAME_TYPE = "paths";

/** Seat-count bounds for every option set (paths §6). */
export const PLAYERS = { min: 2, max: 8 } as const;

/** The board sizes v1 allows: the 35-tile set is sized for 6 × 6 (paths §6). */
export const BOARD_SIZES = [6] as const;
export const DEFAULT_BOARD_SIZE = 6;

/** Hand sizes (paths §6). */
export const HAND_SIZE = { min: 1, max: 3, default: 3 } as const;

/** The self-elimination variants (paths §3 step 4). */
export const SELF_ELIMINATION = ["avoidIfPossible", "allowed"] as const;
export const DEFAULT_SELF_ELIMINATION = "avoidIfPossible";

/** The default turn timeout: groups of kids need a quicker pace (paths §6). */
export const DEFAULT_TURN_TIMEOUT_DAYS = 3;

const MAX_BOARD_SIZE = Math.max(...BOARD_SIZES);

const seat = z
  .number()
  .int()
  .min(0)
  .max(PLAYERS.max - 1);
const count = z.number().int().min(0);
const line = z
  .number()
  .int()
  .min(0)
  .max(MAX_BOARD_SIZE - 1);
const tileId = z
  .number()
  .int()
  .min(0)
  .max(TILE_COUNT - 1);
const rotation = z
  .number()
  .int()
  .min(0)
  .max(ROTATIONS - 1);

/** A notch of a square, `{ r, c, n }` (paths §1). */
const positionSchema = z
  .object({
    r: line,
    c: line,
    n: z
      .number()
      .int()
      .min(0)
      .max(NOTCHES - 1),
  })
  .strict();
export type Position = z.infer<typeof positionSchema>;

/** A square, `{ r, c }`. */
const squareSchema = z.object({ r: line, c: line }).strict();

/** A placed tile: its id and its rotation relative to its canonical form (paths §1). */
const placedSchema = z.object({ tileId, rotation }).strict();
export type Placed = z.infer<typeof placedSchema>;

/** Resolved options: every field present (paths §6). */
export const optionsSchema = z
  .object({
    boardSize: z.literal(BOARD_SIZES),
    handSize: z.number().int().min(HAND_SIZE.min).max(HAND_SIZE.max),
    selfElimination: z.enum(SELF_ELIMINATION),
  })
  .strict();
export type Options = z.infer<typeof optionsSchema>;

/**
 * The actions (paths §7). `edgeNotch` is any integer, so an index off the board is the module's
 * `OUT_OF_RANGE`, not a schema failure.
 */
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("place-marker"), edgeNotch: z.number().int() }).strict(),
  z.object({ type: z.literal("place-tile"), tileId, rotation }).strict(),
]);
export type Action = z.infer<typeof actionSchema>;

/** Why a seat is out (paths §7): the framework's `out_reason` names. */
const OUT_REASONS = ["eliminated", "resigned", "timed_out", "declined"] as const;
export type OutReason = (typeof OUT_REASONS)[number];

/** When and why a seat went out; `atAction` orders eliminations (paths §5). */
const outSchema = z.object({ atAction: count, reason: z.enum(OUT_REASONS) }).strict();
export type Out = z.infer<typeof outSchema>;

/** A marker: where it is (null once off the board, removed or before it is placed). */
const markerSchema = z
  .object({ pos: positionSchema.nullable(), out: outSchema.nullable() })
  .strict();
export type Marker = z.infer<typeof markerSchema>;

/** How a finished game ended (paths §5). */
const END_REASONS = ["last-standing", "wipe-out", "board-full"] as const;
export type EndReason = (typeof END_REASONS)[number];

const PHASES = ["markers", "tiles"] as const;
export type Phase = (typeof PHASES)[number];

/** A seat's or the public view (paths §7). */
export const viewSchema = z
  .object({
    boardSize: z.literal(BOARD_SIZES),
    phase: z.enum(PHASES),
    board: z.array(z.array(placedSchema.nullable())),
    markers: z.array(markerSchema),
    toAct: z.array(seat),
    deckCount: count,
    handCounts: z.array(count),
    /** The viewer's own hand; null for the public view. */
    yourHand: z.array(tileId).nullable(),
    /** Everyone's remaining hand once the game is over; null while it is in progress. */
    hands: z.array(z.array(tileId)).nullable(),
    tokenHolder: seat.nullable(),
    endReason: z.enum(END_REASONS).nullable(),
  })
  .strict();
export type View = z.infer<typeof viewSchema>;

/** One marker's movement: its start, then the notch it left each tile it crossed by (paths §7). */
const moveSchema = z.object({ seat, path: z.array(positionSchema).min(2) }).strict();
export type Move = z.infer<typeof moveSchema>;

/** The fields every record has (paths §7). */
const outcome = {
  seat,
  moves: z.array(moveSchema),
  eliminated: z.array(seat),
  collided: z.array(z.tuple([seat, seat])),
  skipped: z.array(seat),
};

/**
 * Public records (02 §2.1 rule 5): the move, the public movement it caused and who went out or
 * was skipped. Never a drawn or returned tile, the deck or anyone's hand.
 */
export const recordSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("place-marker"), ...outcome, edgeNotch: z.number().int().min(0) })
    .strict(),
  z
    .object({ type: z.literal("place-tile"), ...outcome, tileId, rotation, square: squareSchema })
    .strict(),
  z.object({ type: z.literal("resign"), ...outcome }).strict(),
  z.object({ type: z.literal("decline"), ...outcome }).strict(),
  z.object({ type: z.literal("timeout"), ...outcome }).strict(),
]);
export type PublicRecord = z.infer<typeof recordSchema>;
/** The fields every record has. */
export type Outcome = Pick<PublicRecord, "seat" | "moves" | "eliminated" | "collided" | "skipped">;

/** This module's part of `GET /api/v1/catalog` (paths §6). */
export const catalogSchema = z
  .object({
    boardSize: z.object({ values: z.array(z.number().int()), default: z.number().int() }).strict(),
    handSize: z
      .object({ min: z.number().int(), max: z.number().int(), default: z.number().int() })
      .strict(),
    selfElimination: z
      .object({ values: z.array(z.enum(SELF_ELIMINATION)), default: z.enum(SELF_ELIMINATION) })
      .strict(),
    tiles: z.number().int(),
  })
  .strict();
export type Catalog = z.infer<typeof catalogSchema>;

/** The paths game takes no `GAMES_PATHS_*` configuration (paths §6). */
export const configSchema = z.object({}).strict();

/** Every code the module returns; none is reserved (02 §2.2, paths §6, §7). */
export const ERROR_CODES = {
  /** `resolveOptions`: the input isn't an object. */
  optionsNotObject: "OPTIONS_NOT_OBJECT",
  /** `resolveOptions`: a key that isn't an option. */
  unknownOption: "UNKNOWN_OPTION",
  /** `resolveOptions`: a value the option doesn't allow. */
  invalidOption: "INVALID_OPTION",
  /** `validate`: the seat isn't to act (the framework never asks). */
  notToAct: "NOT_TO_ACT",
  /** `validate`: the action's type doesn't match the phase. */
  wrongPhase: "WRONG_PHASE",
  /** `validate`: the edge notch is off the board. */
  outOfRange: "OUT_OF_RANGE",
  /** `validate`: another marker is on that edge notch. */
  notchOccupied: "NOTCH_OCCUPIED",
  /** `validate`: the tile isn't in the seat's hand. */
  notInHand: "NOT_IN_HAND",
  /** `validate`: the placement eliminates the mover, and another option in hand wouldn't. */
  selfEliminationAvoidable: "SELF_ELIMINATION_AVOIDABLE",
} as const;
