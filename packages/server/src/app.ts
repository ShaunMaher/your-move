import { OpenAPIHono } from "@hono/zod-openapi";
import {
  configRoute,
  healthRoute,
  SERVER_PATHS,
  SESSION_COOKIE_SCHEME,
  type ErrorCode,
} from "@your-move/shared";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { matchedRoutes } from "hono/route";

import { registerAuthRoutes } from "./auth/routes.js";
import { readSessionCookie } from "./auth/session.js";
import { isLocalDev } from "./config/local-dev.js";
import { deriveSubkeys, type Subkeys } from "./crypto/subkeys.js";
import { createGameRegistry, type InstalledGame } from "./games/registry.js";
import { createResourceProvider } from "./games/resources.js";
import { registerGameRoutes } from "./games/routes.js";
import { ApiError } from "./http/api-error.js";
import { webManifest } from "./http/manifest.js";
import { apiBodyLimit, requestRules } from "./http/request-rules.js";
import { API_CACHE_CONTROL, securityHeadersMiddleware } from "./http/security-headers.js";
import type { AppEnv, Platform } from "./platform.js";

export type { AppEnv, Platform } from "./platform.js";
export type { InstalledGame } from "./games/registry.js";

export interface AppOptions {
  readonly platform: Platform;
  /** The generated registry, injected by the runtime; the core never imports it (02 §7.3). */
  readonly games: readonly InstalledGame[];
}

/** The HTTP application `createApp` returns. */
export type App = OpenAPIHono<AppEnv>;

/** An OpenAPI 3.1 document as `@hono/zod-openapi` produces it. */
export type OpenApiDocument = ReturnType<OpenAPIHono["getOpenAPI31Document"]>;

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

/**
 * The stack's frames without its header, which repeats the (possibly input-derived) message. V8
 * formats the stack lazily as `String(error)` and then the frames, and the message may span lines
 * that look like frames (`JSON.parse` quotes its input with the newlines in it), so the header is
 * cut off by its exact text before frames are picked out. A stack that doesn't start with it was
 * formatted some other way: nothing is kept rather than risk keeping the message.
 */
function stackFrames(error: Error): string {
  const stack = error.stack ?? "";
  const header = String(error);
  if (!stack.startsWith(`${header}\n`)) {
    return "";
  }
  return stack
    .slice(header.length + 1)
    .split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .join("\n");
}

/**
 * What a server fault's log entry may say (09 §5). Errors that wrap another — a database driver's
 * query error carries the SQL and its parameters (addresses, token hashes) in its message — and
 * parse errors, whose message quotes the parsed text, are logged by class, stack frames and the
 * cause's class or code only. Other errors keep their message.
 */
function faultFields(error: Error): Record<string, string | undefined> {
  const cause: unknown = error.cause;
  if (cause !== undefined || error instanceof SyntaxError) {
    const causeCode =
      typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
    return {
      // The constructor name tells a wrapped driver error (`DrizzleQueryError`) apart.
      errorClass: error.constructor.name,
      stack: stackFrames(error),
      ...(cause instanceof Error ? { causeClass: cause.name } : {}),
      ...(typeof causeCode === "string" ? { causeCode } : {}),
    };
  }
  return { errorClass: error.name, errorMessage: error.message, stack: error.stack };
}

const REQUEST_RULE_MESSAGES = {
  BAD_REQUEST: "Send a session cookie or a bearer token, not both.",
  BAD_ORIGIN: "Cross-origin request refused.",
  UNSUPPORTED_MEDIA_TYPE: "Send JSON.",
} as const;

/** The route pattern that answered, never the raw path (09 §5). */
function respondedRoute(c: Context): string {
  return matchedRoutes(c)[c.req.routeIndex]?.path ?? "(unmatched)";
}

/**
 * Builds the HTTP application: security headers on every response, the versioned public API under
 * `/api/v1`, and JSON errors for every server-handled path. Runtimes add static file serving (Node)
 * or rely on Workers Static Assets (Cloudflare).
 *
 * Throws at startup for a configuration the games or their resources refuse (`GameConfigError`,
 * `ResourceConfigError`), naming the variable and never its value (02 §2.1 rule 8).
 */
export function createApp(options: AppOptions): App {
  const { platform } = options;
  const { config, log } = platform;
  const resources = createResourceProvider({
    dictionaries: platform.dictionaries,
    enabled: config.dictionariesEnabled,
    now: () => platform.now().getTime(),
  });
  const registry = createGameRegistry(options.games, {
    gameConfig: config.gameConfig,
    enabledGames: config.enabledGames,
    resources: resources.enabled(),
  });

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

  const localDev = isLocalDev(config);
  app.use("/api/*", apiBodyLimit());
  app.use(
    "/api/*",
    requestRules({
      origin: new URL(config.publicUrl).origin,
      hasSessionCookie: (header) => readSessionCookie(header, localDev) !== null,
      reject: (status, code) =>
        new Response(JSON.stringify(errorBody(code, REQUEST_RULE_MESSAGES[code])), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    }),
  );

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

  // Generated from config at runtime, so a prebuilt bundle carries no name (03 §9). Revalidated
  // like the shell: a renamed instance shows its new name on the next load.
  app.get("/manifest.webmanifest", (c) =>
    c.body(JSON.stringify(webManifest(config)), 200, {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "no-cache",
    }),
  );

  let subkeys: Promise<Subkeys> | null = null;
  const keys = (): Promise<Subkeys> => (subkeys ??= deriveSubkeys(config.appSecret));
  registerAuthRoutes(app, { platform, keys });
  registerGameRoutes(app, { platform, registry, resources, keys });

  // Dev only (06 §4, 09 §2, 08 T19): registered only in local-dev mode, so a production config
  // answers 404 from the catch-all below.
  if (localDev) {
    // Only for requests addressed to PUBLIC_URL's own host, so a page on another name that
    // resolves here (DNS rebinding) can't read codes (M2b review S-8).
    const devHost = new URL(config.publicUrl).host;
    app.get("/__dev/emails", (c) =>
      (c.req.header("Host") ?? devHost) === devHost
        ? c.json({ emails: platform.email.captured?.() ?? [] }, 200)
        : c.json(errorBody("NOT_FOUND", "Not found."), 404),
    );
  }

  app.openAPIRegistry.registerComponent("securitySchemes", "sessionCookie", SESSION_COOKIE_SCHEME);
  const document = openApiDocument(app, config.appName);
  app.get("/api/v1/openapi.json", (c) => c.json(document, 200));

  // Server-handled paths never fall through to the SPA.
  for (const path of SERVER_PATHS) {
    app.all(path, (c) => c.json(errorBody("NOT_FOUND", "Not found."), 404));
  }

  app.onError((error, c) => {
    const context = { requestId: c.get("requestId"), route: respondedRoute(c as Context) };
    if (error instanceof ApiError) {
      // A refusal the handler chose (05 §Errors): the client's to act on, not a server fault.
      log.info("request refused", { ...context, status: error.status, code: error.code });
      return new Response(JSON.stringify(error.body()), {
        status: error.status,
        headers: { "Content-Type": "application/json" },
      });
    }
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
    // V8's JSON.parse messages quote the text being parsed, which may be input or game secrets, so
    // a SyntaxError is logged by class and stack frames only (09 §5).
    log.error("unhandled error", { ...context, ...faultFields(error) });
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
