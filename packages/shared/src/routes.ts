import { createRoute, z } from "@hono/zod-openapi";

import { ErrorResponseSchema } from "./errors.js";

/** Every public endpoint lives under this prefix (docs/spec/05-api.md §Versioning). */
export const API_V1 = "/api/v1";

const errorContent = { "application/json": { schema: ErrorResponseSchema } } as const;

export const HealthResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict()
  .openapi("HealthResponse");

/** `GET /api/v1/health` (public): `200 { ok: true }`, no version or config details (05). */
export const healthRoute = createRoute({
  operationId: "getHealth",
  "x-scope": "public",
  method: "get",
  path: `${API_V1}/health`,
  tags: ["Health"],
  summary: "Liveness check",
  description:
    "Public. Answers `{ ok: true }` while the server is up. Also served unversioned at `/api/health` for load balancers and container health checks.",
  responses: {
    200: {
      description: "The server is up.",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
    500: { description: "Unexpected error.", content: errorContent },
  },
});

export const ClientConfigSchema = z
  .object({
    appName: z.string().openapi({ description: "Display name of this instance (APP_NAME)." }),
    appShortName: z
      .string()
      .openapi({ description: "Home-screen label of this instance (APP_SHORT_NAME)." }),
    operatorContact: z.string().openapi({ description: "How to reach the instance operator." }),
    minAge: z.number().int().openapi({ description: "Minimum age confirmed at onboarding." }),
    vapidPublicKey: z
      .string()
      .optional()
      .openapi({ description: "Web Push application server key, when push is configured." }),
    turnstileSiteKey: z
      .string()
      .optional()
      .openapi({ description: "Turnstile site key, when Turnstile is enabled." }),
    uploadsEnabled: z
      .boolean()
      .openapi({ description: "Whether players may upload word lists (DICTIONARY_UPLOADS)." }),
  })
  .strict()
  .openapi("ClientConfig");

/** `GET /api/v1/config` (public): non-sensitive instance configuration (05 §Catalog, config, health). */
export const configRoute = createRoute({
  operationId: "getConfig",
  "x-scope": "public",
  method: "get",
  path: `${API_V1}/config`,
  tags: ["Config"],
  summary: "Instance configuration for clients",
  description: "Public. Non-sensitive values only.",
  responses: {
    200: {
      description: "The instance's client configuration.",
      content: { "application/json": { schema: ClientConfigSchema } },
    },
    500: { description: "Unexpected error.", content: errorContent },
  },
});
