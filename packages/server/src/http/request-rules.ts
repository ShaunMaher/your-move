/**
 * Request rules for the API (docs/spec/05-api.md §Conventions, 08 T6): the CSRF `Origin` check on
 * state-changing requests, JSON-only bodies and the 16 kB body limit.
 *
 * The exemptions are listed here and nowhere else (05): the unsubscribe route is exempt from both
 * rules (mail clients post its one-click form cross-origin, RFC 8058), and the dictionary upload
 * route (M6) will be exempt from the JSON rule only.
 */
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";

import { UNSUBSCRIBE_PATH } from "../email/unsubscribe-token.js";
import type { AppEnv } from "../platform.js";

/** Paths exempt from the Origin rule (05 §Conventions). */
const ORIGIN_EXEMPT: ReadonlySet<string> = new Set<string>([UNSUBSCRIBE_PATH]);
/** Paths exempt from the JSON rule (05 §Conventions). */
const JSON_EXEMPT: ReadonlySet<string> = new Set<string>([UNSUBSCRIBE_PATH]);

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BODY_LIMIT_BYTES = 16 * 1024;

/** `application/json`, with or without parameters such as `charset`. */
function isJson(contentType: string | undefined): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

export interface RequestRuleOptions {
  /** `PUBLIC_URL`'s origin. */
  readonly origin: string;
  /** Whether the request carries the session cookie. */
  readonly hasSessionCookie: (cookieHeader: string | undefined) => boolean;
  /** Answers an error with the framework's JSON error body. */
  readonly reject: (
    status: 400 | 403 | 415,
    code: "BAD_REQUEST" | "BAD_ORIGIN" | "UNSUPPORTED_MEDIA_TYPE",
    c: Context<AppEnv>,
  ) => Response;
}

/**
 * The Origin and JSON rules (05 §Conventions):
 *
 * - a state-changing request carrying the session cookie must have `Origin` equal to
 *   `PUBLIC_URL`'s origin, else `403 BAD_ORIGIN`. Bearer-token requests without a cookie are exempt
 *   (browsers never attach them). As defence in depth, any state-changing request whose `Origin`
 *   names another origin is refused too: with no CORS, no legitimate browser sends one;
 * - a request with a body must be `application/json`, else `415`.
 */
export function requestRules(options: RequestRuleOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const path = c.req.path;
    const cookie = options.hasSessionCookie(c.req.header("Cookie"));
    const bearer = c.req.header("Authorization") !== undefined;
    // A cookie and a bearer token on one request are refused everywhere (05 §Conventions).
    if (cookie && bearer) return options.reject(400, "BAD_REQUEST", c);
    const bearerOnly = !cookie && bearer;
    if (STATE_CHANGING.has(c.req.method) && !ORIGIN_EXEMPT.has(path) && !bearerOnly) {
      const origin = c.req.header("Origin");
      if (
        (cookie && origin !== options.origin) ||
        (origin !== undefined && origin !== options.origin)
      ) {
        return options.reject(403, "BAD_ORIGIN", c);
      }
    }
    if (!JSON_EXEMPT.has(path)) {
      // Whether there is a body is read from the body itself (at most 16 kB: the body limit runs
      // first), not from framing headers, which in-process and HTTP/2 requests may lack; the Node
      // adapter gives every non-GET request a stream, empty or not. Hono caches the text, so the
      // route's validator parses the same bytes.
      const text = c.req.raw.body === null ? "" : await c.req.text();
      if (text.length > 0 && !isJson(c.req.header("Content-Type"))) {
        return options.reject(415, "UNSUPPORTED_MEDIA_TYPE", c);
      }
      if (text.length === 0 && c.req.header("Content-Type") !== undefined) {
        // An empty body with a content type is no input: drop the type, so endpoints that take
        // none accept it (05 §Conventions) instead of failing to parse "" as JSON.
        const headers = new Headers(c.req.raw.headers);
        headers.delete("Content-Type");
        c.req.raw = new Request(c.req.raw.url, { method: c.req.method, headers });
      }
    }
    await next();
    return undefined;
  };
}

/** The 16 kB body limit (05 §Conventions): `413 TOO_LARGE` through the app's error handler. */
export function apiBodyLimit(): MiddlewareHandler {
  return bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: () => {
      throw new HTTPException(413);
    },
  });
}
