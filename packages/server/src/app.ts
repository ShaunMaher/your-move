import { OpenAPIHono } from "@hono/zod-openapi";
import type { GameManifest } from "@your-move/sdk";
import { configRoute, healthRoute, type ErrorCode } from "@your-move/shared";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { matchedRoutes } from "hono/route";

import type { AppConfig } from "./config/parse.js";
import { API_CACHE_CONTROL, securityHeadersMiddleware } from "./http/security-headers.js";
import type { Logger } from "./log.js";

/**
 * What the runtime provides to the core (docs/spec/03-architecture.md §4). M0 needs only the
 * configuration, the logger and the clock; storage, realtime, email, push, blobs and `waitUntil`
 * join as the milestones that use them arrive.
 */
export interface Platform {
  readonly config: AppConfig;
  readonly log: Logger;
  /** Injectable clock: tests control time through it. */
  now(): Date;
}

/**
 * One installed game package, as the generated server registry lists it (02 §7.3). `engines` maps
 * each supported rules version to its `GameDefinition` (typed by the SDK from M1).
 */
export interface InstalledGame {
  readonly manifest: GameManifest;
  readonly engines: Readonly<Record<string, unknown>>;
  readonly enabledByDefault: boolean;
}

export interface AppOptions {
  readonly platform: Platform;
  /** The generated registry, injected by the runtime; the core never imports it (02 §7.3). */
  readonly games: readonly InstalledGame[];
}

/** Hono environment of the app: per-request variables. */
export interface AppEnv {
  Variables: { requestId: string };
}

/** The HTTP application `createApp` returns. */
export type App = OpenAPIHono<AppEnv>;

/** An OpenAPI 3.1 document as `@hono/zod-openapi` produces it. */
export type OpenApiDocument = ReturnType<OpenAPIHono["getOpenAPI31Document"]>;

/** Paths the server always handles; on Cloudflare these run the Worker first (03 §9). */
export const SERVER_PATHS = ["/api/*", "/manifest.webmanifest", "/__dev/*"] as const;

function errorBody(code: ErrorCode, message: string) {
  return { error: { code, message } };
}

/**
 * The client-error statuses 05 §Errors maps to a single framework code. An `HTTPException` with one
 * of these is a rejected request (body limit, malformed JSON, validation): it keeps its status and
 * code. Statuses with several codes (403, 409) are answered by the handler that knows which one.
 */
const REJECTION_CODES: Partial<Record<number, ErrorCode>> = {
  400: "BAD_REQUEST",
  401: "UNAUTHENTICATED",
  404: "NOT_FOUND",
  413: "TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "RATE_LIMITED",
};

/** The stack without its first line, which repeats the (possibly input-derived) message. */
function stackFrames(error: Error): string {
  return (error.stack ?? "")
    .split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .join("\n");
}

/** The route pattern that answered, never the raw path (09 §5). */
function respondedRoute(c: Context): string {
  return matchedRoutes(c)[c.req.routeIndex]?.path ?? "(unmatched)";
}

/**
 * Builds the HTTP application: security headers on every response, the versioned public API under
 * `/api/v1`, and JSON errors for every server-handled path. Runtimes add static file serving (Node)
 * or rely on Workers Static Assets (Cloudflare).
 */
export function createApp(options: AppOptions): App {
  const { platform } = options;
  const { config, log } = platform;

  const app = new OpenAPIHono<AppEnv>({
    // Request validation failures never echo input values (09 §5).
    defaultHook: (result, c) =>
      result.success ? undefined : c.json(errorBody("BAD_REQUEST", "Invalid request."), 400),
  });

  app.use("*", async (c, next) => {
    const started = platform.now().getTime();
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    await next();
    log.info("request", {
      requestId,
      method: c.req.method,
      route: respondedRoute(c as Context),
      status: c.res.status,
      durationMs: platform.now().getTime() - started,
    });
  });

  app.use(
    "*",
    securityHeadersMiddleware({
      hsts: config.publicUrl.startsWith("https:"),
      turnstile: config.turnstile !== null,
    }),
  );

  app.use("/api/*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", API_CACHE_CONTROL);
  });

  // Unversioned, for load balancers and container health checks (05 §Versioning).
  app.get("/api/health", (c) => c.json({ ok: true as const }, 200));

  app.openapi(healthRoute, (c) => c.json({ ok: true as const }, 200));

  app.openapi(configRoute, (c) =>
    c.json(
      {
        appName: config.appName,
        appShortName: config.appShortName,
        operatorContact: config.operatorContact,
        minAge: config.minAge,
        ...(config.vapid ? { vapidPublicKey: config.vapid.publicKey } : {}),
        ...(config.turnstile ? { turnstileSiteKey: config.turnstile.siteKey } : {}),
        uploadsEnabled: config.dictionaryUploads,
      },
      200,
    ),
  );

  const document = openApiDocument(app, config.appName);
  app.get("/api/v1/openapi.json", (c) => c.json(document, 200));

  // Server-handled paths never fall through to the SPA.
  for (const path of SERVER_PATHS) {
    app.all(path, (c) => c.json(errorBody("NOT_FOUND", "Not found."), 404));
  }

  app.onError((error, c) => {
    const context = { requestId: c.get("requestId"), route: respondedRoute(c as Context) };
    const code = error instanceof HTTPException ? REJECTION_CODES[error.status] : undefined;
    if (error instanceof HTTPException && code !== undefined) {
      // A request the client got wrong: its own status and code, not an error-level log, and never
      // the message, which can quote the input (09 §5).
      log.info("request rejected", {
        ...context,
        status: error.status,
        errorClass: error.name,
        stack: stackFrames(error),
      });
      return c.json(errorBody(code, "The request was rejected."), error.status);
    }
    // Anything else is a server fault, including an HTTPException with a 5xx or unmapped status
    // and a SyntaxError from parsing something other than the request (stored JSON, an engine).
    log.error("unhandled error", {
      ...context,
      errorClass: error.name,
      errorMessage: error.message,
      stack: error.stack,
    });
    return c.json(errorBody("INTERNAL", "Something went wrong."), 500);
  });

  return app;
}

/**
 * The public OpenAPI 3.1 document for the routes registered on `app` (05 §Versioning). The title
 * comes from `APP_NAME`; nothing else in it depends on configuration.
 */
export function openApiDocument(app: App, appName: string): OpenApiDocument {
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: `${appName} API`,
      version: "1",
      description:
        "The public HTTP API. Everything is under /api/v1; changes within v1 are additive only.",
    },
  });
}
