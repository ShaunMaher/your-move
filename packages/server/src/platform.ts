/**
 * The `Platform` port (docs/spec/03-architecture.md §4) and the app's Hono environment, apart from
 * `app.ts` so route modules can use them without importing the app.
 */
import type { ClientIp } from "./auth/client-ip.js";
import type { ActiveSession } from "./auth/session.js";
import type { AppConfig } from "./config/parse.js";
import type { Repositories } from "./db/repositories.js";
import type { CapturedEmail, EmailSender } from "./email/sender.js";
import type { BuiltinDictionaries } from "./games/resources.js";
import type { Logger } from "./log.js";

/**
 * What the runtime provides to the core. Storage arrived in M2a, email and the client address in
 * M2b, the built-in dictionaries in A2; realtime and push join in M3/M4, blobs in M6.
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
  readonly email: EmailSender & { captured?: () => readonly CapturedEmail[] };
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

/** Hono environment of the app: per-request variables. */
export interface AppEnv {
  Variables: {
    requestId: string;
    /** Set by the session middleware on session-only routes. */
    session: ActiveSession;
  };
}
