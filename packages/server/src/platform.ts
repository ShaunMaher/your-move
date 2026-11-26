/**
 * The `Platform` port (docs/spec/03-architecture.md §4) and the app's Hono environment, apart from
 * `app.ts` so route modules can use them without importing the app.
 */
import type { ClientIp } from "./auth/client-ip.js";
import type { ActiveSession } from "./auth/session.js";
import type { AppConfig } from "./config/parse.js";
import type { Repositories } from "./db/repositories.js";
import type { CoreEmailSender } from "./email/providers.js";
import type { BuiltinDictionaries } from "./games/resources.js";
import type { Logger } from "./log.js";
import type { PushSender } from "./push/sender.js";

/**
 * What the runtime provides to the core. Storage arrived in M2a, email and the client address in
 * M2b, the built-in dictionaries in A2, Web Push in alpha A8; realtime joins in M3, blobs in M6.
 *
 * Background work (`waitUntil`) is per request, not per isolate: on Workers it is the request's
 * `ctx.waitUntil`, which the runtime hands to `app.fetch(request, env, ctx)`; Node passes an
 * execution context of its own that tracks the work until shutdown. The core reaches it through
 * Hono's `c.executionCtx`.
 */
export interface Platform {
  /** Async repository interfaces, never a Drizzle object (03 §4). */
  readonly repos: Repositories;
  readonly config: AppConfig;
  readonly log: Logger;
  /** Sends email (09 §2); called only in the background (06 §3.2). */
  readonly email: CoreEmailSender;
  /**
   * Sends Web Push messages (03 §7), built by the core's `corePushSender`; called only in the
   * background. Disabled when VAPID isn't configured.
   */
  readonly push: PushSender;
  /**
   * The client address of a request (08 §4.1): `CF-Connecting-IP` on Workers; on Node by
   * `TRUST_PROXY`. `env` is what the runtime passed to `app.fetch`.
   */
  clientIp(request: Request, env: unknown): ClientIp;
  /**
   * The built-in dictionaries: the build's index and a loader for one word list (03 §10), from the
   * static assets on Workers and from disk on Node.
   */
  readonly dictionaries: BuiltinDictionaries;
  /** Injectable clock: tests control time through it. */
  now(): Date;
}

/**
 * The fixed reasons a `BAD_REQUEST` can carry beyond its code (09 §5). Kept here with the context
 * variable that carries it, so `platform.ts` needn't import the error-log module.
 */
export type ErrorReason = "invalid_email" | "no_email" | "no_client_ip";

/** What a failed request leaves for its log line. */
export interface ErrorLog {
  readonly code: string;
  /** A fixed label for a refusal several places can raise (09 §5); never input-derived. */
  readonly reason?: ErrorReason;
  /** `path:zodCode` pairs, comma-separated (log fields are flat): `json.email:invalid_format`. */
  readonly issues?: string;
}

/** Hono environment of the app: per-request variables. */
export interface AppEnv {
  Variables: {
    requestId: string;
    /** Set by the session middleware on session-only routes. */
    session: ActiveSession;
    /** Set where an error response is built, read by the request log (09 §5). */
    errorLog?: ErrorLog;
  };
}
