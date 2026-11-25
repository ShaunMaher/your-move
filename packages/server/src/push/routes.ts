/**
 * The push subscription endpoints (docs/spec/05-api.md §Push subscriptions; alpha A8): save this
 * device's subscription for the current session, or remove one. Session only (05 §Token scopes).
 * The endpoint and keys are checked against 08 T12 before anything is stored, and what is stored
 * is the parsed endpoint, the one every later push goes to.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { subscribePushRoute, unsubscribePushRoute } from "@your-move/shared";

import { checkLimits } from "../auth/limits.js";
import { requireSession } from "../auth/require-session.js";
import type { UserRecord } from "../db/repositories.js";
import { ApiError } from "../http/api-error.js";
import type { AppEnv, Platform } from "../platform.js";
import { MAX_SUBSCRIPTIONS_PER_USER, parseEndpoint, parseKeys } from "./endpoint.js";

export function registerPushRoutes(app: OpenAPIHono<AppEnv>, platform: Platform): void {
  const { repos, config } = platform;
  const now = (): number => platform.now().getTime();

  // Registered before the handlers, so it runs first, for both methods.
  app.use(subscribePushRoute.path, requireSession(platform));

  /** Any authenticated write per user (08 §4). */
  const limit = async (user: UserRecord): Promise<void> => {
    const [result] = await checkLimits(repos, config, now(), [
      { name: "WRITES_USER_MINUTE", key: user.id, amount: 1 },
    ]);
    if (result?.exceeded !== false) throw ApiError.of("RATE_LIMITED");
  };

  app.openapi(subscribePushRoute, async (c) => {
    const { session, user } = c.get("session");
    await limit(user);
    const body = c.req.valid("json");
    const endpoint = parseEndpoint(body.endpoint);
    if (endpoint === null || (await parseKeys(body.keys)) === null) {
      throw ApiError.of("BAD_REQUEST");
    }
    await repos.pushSubscriptions.save(
      {
        id: crypto.randomUUID(),
        userId: user.id,
        sessionId: session.id,
        endpoint: endpoint.href,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        createdAt: now(),
      },
      MAX_SUBSCRIPTIONS_PER_USER,
    );
    return c.body(null, 204);
  });

  app.openapi(unsubscribePushRoute, async (c) => {
    const { user } = c.get("session");
    await limit(user);
    // Stored endpoints are parsed ones; one that doesn't parse was never stored.
    const endpoint = parseEndpoint(c.req.valid("json").endpoint);
    if (endpoint !== null) await repos.pushSubscriptions.remove(user.id, endpoint.href);
    return c.body(null, 204);
  });
}
