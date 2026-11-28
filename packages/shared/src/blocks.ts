/**
 * Block endpoints (docs/spec/05-api.md §Blocks, 06 §6.10; alpha A23): list, create and remove your
 * own blocks. Session only (05 §Token scopes). A block is never shown to the person blocked, and
 * what it changes in a lobby is written exactly as a Remove or a Decline.
 */
import { createRoute, z } from "@hono/zod-openapi";

import { errors } from "./error-responses.js";
import { API_V1 } from "./routes.js";

const SESSION = [{ sessionCookie: [] }];

const COMMON_ERRORS = {
  400: "Invalid request (`BAD_REQUEST`).",
  401: "No valid session (`UNAUTHENTICATED`).",
  500: "Unexpected error.",
} as const;

const UserId = z.string().min(1).max(64);

/** One page of `GET /api/v1/blocks`. */
export const BlockListSchema = z
  .object({
    blocks: z.array(
      z
        .object({
          userId: z.string(),
          displayName: z.string().nullable().openapi({
            description: "Their current display name; null only for an account without one.",
          }),
          createdAt: z
            .number()
            .int()
            .openapi({ description: "When you blocked them (ms since the epoch)." }),
        })
        .strict(),
    ),
    nextCursor: z.string().nullable().openapi({
      description: "Pass as `?cursor=` for the next page; null on the last one.",
    }),
  })
  .strict()
  .openapi("BlockList");

/** `POST /api/v1/blocks`. */
export const BlockBodySchema = z
  .object({
    userId: UserId.openapi({
      description:
        "The person to block: a past opponent, or someone who holds or held a row in a game with you.",
    }),
  })
  .strict()
  .openapi("BlockRequest");

export const listBlocksRoute = createRoute({
  operationId: "listBlocks",
  "x-scope": "session",
  security: SESSION,
  method: "get",
  path: `${API_V1}/blocks`,
  tags: ["Blocks"],
  summary: "The people you've blocked",
  description: "Session only. Newest first, 100 per page.",
  request: {
    query: z.object({ cursor: z.string().max(200).optional() }).strict(),
  },
  responses: {
    200: {
      description: "Your blocks.",
      content: { "application/json": { schema: BlockListSchema } },
    },
    ...errors({ ...COMMON_ERRORS, 403: "`SUSPENDED`." }),
  },
});

export const createBlockRoute = createRoute({
  operationId: "createBlock",
  "x-scope": "session",
  security: SESSION,
  method: "post",
  path: `${API_V1}/blocks`,
  tags: ["Blocks"],
  summary: "Block someone",
  description:
    "Session only. Blocks a past opponent, or someone who holds or held a row in a game with you; they are never told. It removes you from each other's past opponents, and in each lobby you share where you can already tell their row is theirs (they have joined, or you created it and picked them) it removes their seat if you created the lobby and otherwise declines yours, exactly as Remove or Decline would. Games already under way carry on. `204` also when they were already blocked (a repeat applies it to any lobby left).",
  request: {
    body: { required: true, content: { "application/json": { schema: BlockBodySchema } } },
  },
  responses: {
    204: { description: "Blocked." },
    ...errors({
      ...COMMON_ERRORS,
      403: "`BAD_ORIGIN` (cookie request without this instance's `Origin`), or `SUSPENDED`.",
      404: "No one you can block by that id (`NOT_FOUND`): no shared game or past game, yourself, or an AI account.",
      413: "Body over 16 kB (`TOO_LARGE`).",
      415: "A body that isn't `application/json` (`UNSUPPORTED_MEDIA_TYPE`).",
      429: "Too many writes (`RATE_LIMITED`).",
    }),
  },
});

export const deleteBlockRoute = createRoute({
  operationId: "deleteBlock",
  "x-scope": "session",
  security: SESSION,
  method: "delete",
  path: `${API_V1}/blocks/{userId}`,
  tags: ["Blocks"],
  summary: "Unblock someone",
  description:
    "Session only, body-less. Lifts your block; past opponents it removed stay removed until you finish another game together.",
  request: { params: z.object({ userId: UserId }).strict() },
  responses: {
    204: { description: "Unblocked." },
    ...errors({
      ...COMMON_ERRORS,
      403: "`BAD_ORIGIN`, `ONBOARDING_REQUIRED` (onboarding incomplete, or a re-prompt after a `MIN_AGE` rise, 06 §5) or `SUSPENDED`.",
      404: "You haven't blocked that person (`NOT_FOUND`).",
      429: "Too many writes (`RATE_LIMITED`).",
    }),
  },
});
