/**
 * Request rules for the API (docs/spec/05-api.md §Conventions, 08 T6): the CSRF `Origin` check on
 * state-changing requests, JSON-only bodies and the 16 kB body limit.
 *
 * The exemptions are listed here and nowhere else (05): the unsubscribe route is exempt from both
 * rules and the dictionary upload route from the JSON rule only. Neither exists yet (M4, M6).
 */
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";

/** Paths exempt from the Origin rule (05 §Conventions). */
const ORIGIN_EXEMPT: ReadonlySet<string> = new Set<string>([]);
/** Paths exempt from the JSON rule (05 §Conventions). */
const JSON_EXEMPT: ReadonlySet<string> = new Set<string>([]);

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const BODY_LIMIT_BYTES = 16 * 1024;

/** `application/json`, with or without parameters such as `charset`. */
function isJson(contentType: string | undefined): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function hasBody(headers: Headers): boolean {
  const length = headers.get("Content-Length");
  return (length !== null && length !== "0") || headers.has("Transfer-Encoding");
}

export interface RequestRuleOptions {
  /** `PUBLIC_URL`'s origin. */
  readonly origin: string;
  /** Whether the request carries the session cookie. */
  readonly hasSessionCookie: (cookieHeader: string | undefined) => boolean;
  /** Answers an error with the framework's JSON error body. */
  readonly reject: (status: 403 | 415, code: "BAD_ORIGIN" | "UNSUPPORTED_MEDIA_TYPE") => Response;
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
export function requestRules(options: RequestRuleOptions): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    if (STATE_CHANGING.has(c.req.method) && !ORIGIN_EXEMPT.has(path)) {
      const origin = c.req.header("Origin");
      const cookie = options.hasSessionCookie(c.req.header("Cookie"));
      if (
        (cookie && origin !== options.origin) ||
        (origin !== undefined && origin !== options.origin)
      ) {
        return options.reject(403, "BAD_ORIGIN");
      }
    }
    if (
      hasBody(c.req.raw.headers) &&
      !JSON_EXEMPT.has(path) &&
      !isJson(c.req.header("Content-Type"))
    ) {
      return options.reject(415, "UNSUPPORTED_MEDIA_TYPE");
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
