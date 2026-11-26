/**
 * What the request log line says about a failed request (09 §5): the error code, and for a
 * validation failure the issue paths and Zod issue codes. {@link errorBody} builds every
 * `{ error: { code, message } }` body outside `ApiError` and notes its code on the request context
 * in the same call, so a body and its log entry can't drift apart; the logging middleware reads the
 * note back and never parses a response. Never record input values, Zod messages or request bodies.
 */
import type { Context } from "hono";

import type { AppEnv, ErrorLog, ErrorReason } from "../platform.js";

export type { ErrorLog, ErrorReason };

/** At most this many validation issues are logged, so a hostile body can't bloat the log. */
const MAX_ISSUES = 5;
/** A path segment that looks like a field name; anything else (an input-chosen key) is masked. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/u;

/** The slice of a Zod issue that is safe to log: never `message`, `input` or `received`. */
interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly code: string;
}

/** Records the error `code` the response carries, for the request log line. */
export function noteError(c: Context<AppEnv>, error: ErrorLog): void {
  c.set("errorLog", error);
}

/** The noted error of a failed request. */
export function notedError(c: Context<AppEnv>): ErrorLog | undefined {
  return c.get("errorLog");
}

/** The framework's error body (05 §Conventions), noting its `code` for the request log line. */
export function errorBody<C extends string>(
  c: Context<AppEnv>,
  code: C,
  message: string,
  reason?: ErrorReason,
): { error: { code: C; message: string } } {
  noteError(c, { code, ...(reason === undefined ? {} : { reason }) });
  return { error: { code, message } };
}

/**
 * Paths as `json.email` or `json.items.0.id` (the validation target, then the field path). Only
 * identifier-shaped names are kept and the rest become `*`. That is enough while no request schema
 * has client-chosen keys: Zod v4 reports an unknown key of a `.strict()` object in `keys`, not in
 * `path`, and this never reads `keys`. A future `z.record` keyed by client input puts the key in
 * `path`, and an identifier-shaped key could still be a secret: such a schema must have its
 * record-key segments masked unconditionally.
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
