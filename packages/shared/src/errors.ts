import { z } from "@hono/zod-openapi";

/**
 * Framework error codes (docs/spec/05-api.md §Errors). Clients branch on `code`; `message` is for
 * display. Codes are added here as the endpoints that return them are built.
 */
export const ERROR_CODES = [
  "BAD_REQUEST",
  "NOT_FOUND",
  "TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

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
