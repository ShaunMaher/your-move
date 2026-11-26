/**
 * What the request log line says about a failed request (09 §5): the error code, and for a
 * validation failure the issue paths and Zod issue codes. Whatever builds an error response notes it
 * here on the request context and the logging middleware reads it back, so the response body is
 * never parsed. Never record input values, Zod messages or request bodies.
 */
import type { Context } from "hono";

/** At most this many validation issues are logged, so a hostile body can't bloat the log. */
const MAX_ISSUES = 5;
/** A path segment that looks like a field name; anything else (an input-chosen key) is masked. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/u;

/** What a failed request leaves for its log line. */
export interface ErrorLog {
  readonly code: string;
  /** A fixed, non-input-derived label for a refusal several places can raise (09 §5). */
  readonly reason?: string;
  /** `path:zodCode` pairs, comma-separated (log fields are flat): `json.email:invalid_format`. */
  readonly issues?: string;
}

/** The slice of a Zod issue that is safe to log: never `message`, `input` or `received`. */
interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly code: string;
}

/** Records the error `code` the response carries, for the request log line. */
export function noteError(c: Context, error: ErrorLog): void {
  c.set("errorLog", error);
}

/** The noted error, if the request failed with a body built by {@link noteError}'s callers. */
export function notedError(c: Context): ErrorLog | undefined {
  return c.get("errorLog") as ErrorLog | undefined;
}

/**
 * Paths as `json.email` or `json.items.0.id` (the validation target, then the field path). Object keys the client chose (records, unknown keys)
 * can carry input, so only identifier-like names are kept and the rest become `*`.
 */
export function loggedIssues(target: string, issues: readonly IssueLike[]): string {
  return issues
    .slice(0, MAX_ISSUES)
    .map((issue) => {
      const path = [target, ...issue.path.map(segment)].join(".");
      return `${path}:${/^[a-z_]{1,32}$/u.test(issue.code) ? issue.code : "unknown"}`;
    })
    .join(",");
}

function segment(part: PropertyKey): string {
  if (typeof part === "number") return String(part);
  return typeof part === "string" && FIELD_NAME.test(part) ? part : "*";
}
