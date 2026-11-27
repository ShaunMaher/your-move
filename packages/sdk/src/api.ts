/**
 * The client-facing API types a game client needs, as Zod schemas (docs/spec/02-game-framework.md
 * §7.4, 05 §Common types). The server registers these same schemas on its routes (M3), so the
 * types generated for `@your-move/api-client` are structurally identical.
 */
import { z } from "zod";

const seat = z.number().int().min(0);
const timestamp = z.number().int().min(0);
/**
 * Any value, but present: `z.unknown()` alone accepts a missing key, so an OpenAPI document
 * generated from it would call the field optional although it is always there (02 §7.4).
 */
const present = () => z.unknown().refine((value): boolean => value !== undefined, "Required");

/**
 * Display text: strings and `{ seat }` placeholders (02 §5).
 *
 * @public
 */
export const textSchema = z.array(z.union([z.string(), z.object({ seat }).strict()]));

/**
 * One line in the game list (02 §2).
 *
 * @public
 */
export const listSummarySchema = z
  .object({ headline: textSchema, scores: z.array(z.number()).optional() })
  .strict();

/**
 * A module error as the API returns it from `validate` and `preview` (02 §2.1 rule 3).
 *
 * @public
 */
export const gameErrorSchema = z.object({ code: z.string(), detail: z.unknown().optional() });

/**
 * A framework error (05 §Errors).
 *
 * @public
 */
export const frameworkErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  detail: z.unknown().optional(),
});

/**
 * A framework error.
 *
 * @public
 */
export type FrameworkError = z.infer<typeof frameworkErrorSchema>;

/**
 * Status of a game (02 §4).
 *
 * @public
 */
export const gameStatusSchema = z.enum([
  "lobby",
  "active",
  "finished",
  "declined",
  "cancelled",
  "expired",
]);

/**
 * One row of a game's `players` (05 §Common types).
 *
 * @public
 */
export const gamePlayerSchema = z.object({
  playerId: z.string().optional(),
  seat: seat.nullable(),
  userId: z.string().nullable(),
  displayName: z.string().nullable(),
  kind: z.enum(["human", "agent"]),
  aiOwnerName: z.string().optional(),
  invitedAs: z.string().optional(),
  state: z.enum(["invited", "joined", "declined", "left", "removed", "playing", "out"]),
  outReason: z.enum(["eliminated", "resigned", "timed_out", "declined", "cancelled"]).optional(),
  rank: z.number().int().min(1).optional(),
  score: z.number().optional(),
  deadline: timestamp.optional(),
  isYou: z.boolean(),
  isCreator: z.boolean(),
});

/**
 * A resource a game uses, as the envelope lists it: never blob keys or hashes (05).
 *
 * @public
 */
export const gameResourceSchema = z.object({
  kind: z.literal("dictionary"),
  id: z.string(),
  name: z.string(),
  distribution: z.enum(["public", "serverOnly"]).optional(),
  uploadedBy: z.string().optional(),
  downloadUrl: z.string().optional(),
});

/**
 * Everything the framework says about one game, for one viewer (05 §Common types).
 *
 * @public
 */
export const gameEnvelopeSchema = z.object({
  id: z.string(),
  gameType: z.string(),
  gameVersion: z.number().int().min(1),
  options: present(),
  status: gameStatusSchema,
  version: z.number().int().min(0),
  endReason: z.string().nullable(),
  turnTimeoutDays: z.number().int().min(1).max(30),
  seatOrder: z.enum(["join", "random"]),
  aiAssistance: z.enum(["off", "allowed"]),
  available: z.boolean(),
  resources: z.array(gameResourceSchema),
  players: z.array(gamePlayerSchema),
  yourSeat: seat.nullable(),
  toAct: z.array(seat),
  yourTurn: z.boolean(),
  yourInvitation: z.enum(["normal", "hidden"]).nullable(),
  joinLink: z.object({ active: z.boolean(), expiresAt: timestamp.nullable() }).optional(),
  canAddPlayers: z.array(z.object({ userId: z.string(), displayName: z.string() })).optional(),
  rematch: z
    .object({ gameId: z.string(), you: z.enum(["joined", "invited", "none"]) })
    .nullable()
    .optional(),
  createdAt: timestamp,
  lastActionAt: timestamp.nullable(),
});

/**
 * Everything the framework says about one game, for one viewer.
 *
 * @public
 */
export type GameEnvelope = z.infer<typeof gameEnvelopeSchema>;

/**
 * What the shell's `submit` resolves to (02 §2): the new envelope and the viewer's view, or an
 * error.
 *
 * @public
 */
export const submitResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), game: gameEnvelopeSchema, view: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.union([frameworkErrorSchema, gameErrorSchema]) }),
]);

/**
 * What the shell's `submit` resolves to.
 *
 * @public
 */
export type SubmitResult = z.infer<typeof submitResultSchema>;
