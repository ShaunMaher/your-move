/**
 * The example game's constants, schemas and the types inferred from them
 * (docs/spec/02-game-framework.md §2, §7.6). Every value that crosses the contract (options,
 * actions, views, records, previews, the catalog) has one Zod schema here, built with the Zod
 * that `@your-move/sdk/schema` re-exports (02 §7.1.1).
 */
import { z } from "@your-move/sdk/schema";

/** The game type id; matches the manifest (02 §7.2). */
export const GAME_TYPE = "example";

/** The deck holds one of each card from 1 to `DECK_SIZE`, so no two cards ever tie. */
export const DECK_SIZE = 20;

/** Seat-count bounds for every option set (02 §7.2). */
export const PLAYERS = { min: 2, max: 4 } as const;

/** Option ranges and defaults, shown by the catalog (02 §2). */
export const HAND_SIZE = { min: 3, max: 6, default: 3 } as const;
export const LIVES = { min: 1, max: 3, default: 2 } as const;

/** How a finished game ended (02 §2 `GameResult.endReason`). */
const END_REASONS = ["last-standing", "cards-exhausted"] as const;
export type EndReason = (typeof END_REASONS)[number];

const seat = z
  .number()
  .int()
  .min(0)
  .max(PLAYERS.max - 1);
const card = z.number().int().min(1).max(DECK_SIZE);
const count = z.number().int().min(0);

/** Resolved options: every field present and in range. */
export const optionsSchema = z
  .object({
    handSize: z.number().int().min(HAND_SIZE.min).max(HAND_SIZE.max),
    lives: z.number().int().min(LIVES.min).max(LIVES.max),
  })
  .strict();
export type Options = z.infer<typeof optionsSchema>;

/** The only action: secretly play one card from your hand. */
export const actionSchema = z.object({ card }).strict();
export type Action = z.infer<typeof actionSchema>;

/** One revealed play of a resolved round. */
const playSchema = z.object({ seat, card }).strict();

/** The last resolved round, revealed to everyone once every playing seat has played. */
const lastRoundSchema = z
  .object({
    round: z.number().int().min(1),
    plays: z.array(playSchema),
    /** Played the highest card and scored a point. */
    high: seat,
    /** Played the lowest card and lost a life. */
    low: seat,
    /** `low`, if that life was its last. */
    eliminated: seat.nullable(),
  })
  .strict();
export type LastRound = z.infer<typeof lastRoundSchema>;

/** What one viewer sees of one seat. */
const seatViewSchema = z
  .object({
    status: z.enum(["playing", "out"]),
    lives: count,
    points: count,
    handCount: count,
    /** Whether the seat has made its secret play this round (never which card). */
    played: z.boolean(),
    /** The cards in hand: the viewer's own seat only, every seat's once the game is over. */
    hand: z.array(card).nullable(),
  })
  .strict();

/** A seat's or the public view (02 §2 `view`). */
export const viewSchema = z
  .object({
    round: z.number().int().min(1),
    deckCount: count,
    /** The viewer's seat, or null for the public view. */
    you: seat.nullable(),
    /** The viewer's own secret play this round, if made. */
    yourPlay: card.nullable(),
    seats: z.array(seatViewSchema),
    lastRound: lastRoundSchema.nullable(),
    endReason: z.enum(END_REASONS).nullable(),
  })
  .strict();
export type View = z.infer<typeof viewSchema>;

/**
 * Public records (02 §2.1 rule 5). They hold nothing that depends on hidden state or on random
 * draws: not the card played, not the round's outcome, not who drew what (02 §6.3). The outcome
 * of a round is public through `view().lastRound` instead.
 */
export const recordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("played"), seat, round: z.number().int().min(1) }).strict(),
  z.object({ kind: z.literal("resigned"), seat }).strict(),
  z.object({ kind: z.literal("declined"), seat }).strict(),
  z.object({ kind: z.literal("timedOut"), seat }).strict(),
]);
export type PublicRecord = z.infer<typeof recordSchema>;

/** What playing a card would leave in your hand: depends only on the seat's own hand. */
export const previewSchema = z.object({ handAfter: z.array(card) }).strict();
export type PreviewResult = z.infer<typeof previewSchema>;

const rangeSchema = z
  .object({ min: z.number().int(), max: z.number().int(), default: z.number().int() })
  .strict();

/** This module's part of `GET /api/v1/catalog`. */
export const catalogSchema = z
  .object({ deckSize: z.number().int(), handSize: rangeSchema, lives: rangeSchema })
  .strict();
export type Catalog = z.infer<typeof catalogSchema>;

/** The example game takes no `GAMES_EXAMPLE_*` configuration (02 §2.1 rule 8). */
export const configSchema = z.object({}).strict();

/** Every code the module returns; none is reserved (02 §2.2). */
export const ERROR_CODES = {
  /** `resolveOptions`: the input isn't an object. */
  optionsNotObject: "OPTIONS_NOT_OBJECT",
  /** `resolveOptions`: a key that isn't an option. */
  unknownOption: "UNKNOWN_OPTION",
  /** `resolveOptions`: a value that isn't a whole number in range. */
  optionOutOfRange: "OPTION_OUT_OF_RANGE",
  /** `validateStart`: the deck can't deal a full hand to every seat. */
  deckTooSmall: "DECK_TOO_SMALL",
  /** `validate`: the game is over. */
  gameOver: "GAME_OVER",
  /** `validate`: the seat is out (or doesn't exist). */
  notPlaying: "NOT_PLAYING",
  /** `validate`: the seat has already played this round. */
  alreadyPlayed: "ALREADY_PLAYED",
  /** `validate`: the card isn't in the seat's hand. */
  notInHand: "NOT_IN_HAND",
} as const;
