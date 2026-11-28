/**
 * Push subscription endpoints (docs/spec/05-api.md §Push subscriptions, 08 T12; alpha A8): a
 * device's Web Push subscription, saved for the current session and removed again. Session only.
 */
import { createRoute, z } from "@hono/zod-openapi";

import { errors } from "./error-responses.js";
import { API_V1 } from "./routes.js";

const SESSION = [{ sessionCookie: [] }];

const PUSH_ERRORS = {
  400: "Invalid request, or an endpoint or keys that 08 T12 refuses (`BAD_REQUEST`).",
  401: "No valid session (`UNAUTHENTICATED`).",
  403: "`BAD_ORIGIN` (cookie request without this instance's `Origin`), or `SUSPENDED`.",
  413: "Body over 16 kB (`TOO_LARGE`).",
  415: "A body that isn't `application/json` (`UNSUPPORTED_MEDIA_TYPE`).",
  429: "Too many writes (`RATE_LIMITED`).",
  500: "Unexpected error.",
} as const;

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});

const Endpoint = z
  .string()
  .min(1)
  .max(2048)
  .openapi({
    description:
      "The subscription's endpoint: an `https` URL at an allow-listed push service (08 T12), " +
      "as `PushSubscription.endpoint` gives it.",
    example: "https://fcm.googleapis.com/fcm/send/abc123",
  });

/** `POST /api/v1/push/subscriptions`: the parts of `PushSubscription.toJSON()` the server keeps. */
export const PushSubscriptionBodySchema = z
  .object({
    endpoint: Endpoint,
    keys: z
      .object({
        p256dh: z.string().min(1).max(128).openapi({
          description: "Unpadded base64url of the 65-byte uncompressed P-256 public key.",
        }),
        auth: z
          .string()
          .min(1)
          .max(64)
          .openapi({ description: "Unpadded base64url of the 16-byte auth secret." }),
      })
      .strict(),
  })
  .strict()
  .openapi("PushSubscription");

/** `DELETE /api/v1/push/subscriptions`. */
export const PushUnsubscribeBodySchema = z
  .object({ endpoint: Endpoint })
  .strict()
  .openapi("PushUnsubscribe");

export const subscribePushRoute = createRoute({
  operationId: "subscribePush",
  "x-scope": "session",
  security: SESSION,
  method: "post",
  path: `${API_V1}/push/subscriptions`,
  tags: ["Push"],
  summary: "Save this device's push subscription",
  description:
    "Session only. An idempotent upsert bound to the current session. An endpoint already " +
    "stored for another account or session moves to this one only with the same keys, or once " +
    "that session has ended; otherwise nothing changes. At most 10 per account; the least " +
    "recently useful is evicted. The subscription is deleted with its session.",
  request: { body: jsonBody(PushSubscriptionBodySchema) },
  responses: {
    204: { description: "Saved." },
    ...errors(PUSH_ERRORS),
  },
});

export const unsubscribePushRoute = createRoute({
  operationId: "unsubscribePush",
  "x-scope": "session",
  security: SESSION,
  method: "delete",
  path: `${API_V1}/push/subscriptions`,
  tags: ["Push"],
  summary: "Remove a push subscription",
  description:
    "Session only. Removes the subscription with this endpoint if it belongs to you; " +
    "otherwise does nothing.",
  request: { body: jsonBody(PushUnsubscribeBodySchema) },
  responses: {
    204: { description: "Removed, or there was nothing of yours to remove." },
    ...errors(PUSH_ERRORS),
  },
});
