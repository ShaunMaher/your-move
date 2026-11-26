/**
 * The session gate of every authenticated route (06 §4, 05 §Conventions): a valid, unexpired
 * session cookie of a user who isn't suspended. Bearer tokens arrive in M3; until then a request
 * with an `Authorization` header is refused.
 */
import type { MiddlewareHandler } from "hono";

import { isLocalDev } from "../config/local-dev.js";
import { background } from "../http/background.js";
import { errorBody } from "../http/error-log.js";
import type { AppEnv, Platform } from "../platform.js";
import { clearedSessionCookie, loadSession, readSessionCookie } from "./session.js";

const MESSAGES = {
  BAD_REQUEST: "The request was rejected.",
  UNAUTHENTICATED: "Please sign in.",
  SUSPENDED: "This account is suspended.",
} as const;

export function requireSession(platform: Platform): MiddlewareHandler<AppEnv> {
  const localDev = isLocalDev(platform.config);
  return async (c, next) => {
    const fail = (status: 400 | 401 | 403, code: keyof typeof MESSAGES) =>
      c.json(errorBody(c, code, MESSAGES[code]), status);
    const token = readSessionCookie(c.req.header("Cookie"), localDev);
    if (c.req.header("Authorization") !== undefined) {
      // A cookie and a bearer token together are refused (05 §Conventions); tokens alone can't
      // authenticate until M3.
      return token === null ? fail(401, "UNAUTHENTICATED") : fail(400, "BAD_REQUEST");
    }
    if (token === null) return fail(401, "UNAUTHENTICATED");
    const active = await loadSession(platform.repos, token, platform.now().getTime(), (task) => {
      background(c, platform, task);
    });
    if (active === null) {
      c.header("Set-Cookie", clearedSessionCookie(localDev), { append: true });
      return fail(401, "UNAUTHENTICATED");
    }
    if (active.user.suspendedAt !== null) return fail(403, "SUSPENDED");
    c.set("session", active);
    await next();
    return undefined;
  };
}
