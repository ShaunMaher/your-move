import { z } from "@hono/zod-openapi";

/**
 * Framework error codes (docs/spec/05-api.md §Errors), by status. Clients branch on `code`;
 * `message` is for display. The codes are reserved: a game module may not use them (02 §2.2).
 */
export const ERROR_STATUS = {
  BAD_REQUEST: 400,
  INVALID_CODE: 400,
  INVALID_ACTION: 400,
  INVALID_OPTIONS: 400,
  INVALID_SEAT_COUNT: 400,
  INVALID_TIMEOUT: 400,
  INVALID_INVITEES: 400,
  AI_SEATS_NOT_ALLOWED: 400,
  CANNOT_PLAY_SELF: 400,
  UNKNOWN_GAME: 400,
  INVALID_DICTIONARY: 400,
  UNAUTHENTICATED: 401,
  BAD_ORIGIN: 403,
  NOT_ALLOWED: 403,
  ONBOARDING_REQUIRED: 403,
  AI_NOT_ALLOWED: 403,
  INSUFFICIENT_SCOPE: 403,
  AGENT_NOT_ALLOWED: 403,
  SUSPENDED: 403,
  NOT_FOUND: 404,
  STALE_GAME: 409,
  GAME_NOT_ACTIVE: 409,
  GAME_UNAVAILABLE: 409,
  NOT_YOUR_TURN: 409,
  WRONG_STATUS: 409,
  NOT_ENOUGH_PLAYERS: 409,
  INVALID_SEATS: 409,
  ALREADY_ACTED: 409,
  ALREADY_JOINED: 409,
  TOO_MANY_GAMES: 409,
  REMATCH_UNAVAILABLE: 409,
  TOO_MANY_DICTIONARIES: 409,
  TOO_MANY_TOKENS: 409,
  TOO_MANY_AGENTS: 409,
  TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UPLOADS_FULL: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** Every framework error code (05 §Errors). */
export const ERROR_CODES = Object.keys(ERROR_STATUS) as readonly ErrorCode[];

/** `{"error": {"code", "message", "detail"?}}` (05 §Conventions). */
export const ErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string().openapi({ example: "NOT_FOUND" }),
        message: z.string(),
        detail: z.unknown().optional(),
      })
      .strict(),
  })
  .strict()
  .openapi("ErrorResponse");

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
