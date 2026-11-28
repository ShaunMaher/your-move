import { createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { ApiError } from "./http/api-error.js";
import { loggedIssues } from "./http/error-log.js";
import { securityHeaders } from "./http/security-headers.js";
import { createJsonLogger } from "./log.js";
import { PROD_ENV, TEST_VAPID, testPlatform } from "./test-support.js";

function setup(env = PROD_ENV) {
  const platform = testPlatform(env);
  const app = createApp({ platform, games: [], onboardingClaims: 8, blockLobbies: 6 });
  return { platform, app };
}

describe("health", () => {
  it.each(["/api/health", "/api/v1/health"])("GET %s answers { ok: true }", async (path) => {
    const { app } = setup();
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/u);
  });
});

describe("GET /api/v1/config", () => {
  it("returns only non-sensitive values", async () => {
    const { app } = setup({
      ...PROD_ENV,
      APP_NAME: "Family Games",
      VAPID_PUBLIC_KEY: TEST_VAPID.publicKey,
      VAPID_PRIVATE_KEY: TEST_VAPID.privateKey,
      VAPID_SUBJECT: "mailto:ops@example.org",
      PRIVACY_RETENTION: "Logs 14 days, backups 30 days.",
    });
    const res = await app.request("/api/v1/config");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({
      appName: "Family Games",
      appShortName: "Family Games",
      operatorContact: "ops@example.org",
      minAge: 13,
      privacyRetention: "Logs 14 days, backups 30 days.",
      vapidPublicKey: TEST_VAPID.publicKey,

      uploadsEnabled: true,
    });
    expect(body).not.toContain(TEST_VAPID.privateKey);
    expect(body).not.toMatch(/smtp:\/\//u);
  });

  it("omits optional keys that are not configured", async () => {
    const { app } = setup();
    const body = (await (await app.request("/api/v1/config")).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("vapidPublicKey");
    expect(body).not.toHaveProperty("turnstileSiteKey");
    expect(body).not.toHaveProperty("privacyRetention");
  });
});

describe("GET /api/v1/openapi.json", () => {
  it("serves an OpenAPI 3.1 document titled from APP_NAME", async () => {
    const { app } = setup({ ...PROD_ENV, APP_NAME: "Family Games" });
    const res = await app.request("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, unknown>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Family Games API");
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/api/v1/auth/logout",
      "/api/v1/auth/logout-all",
      "/api/v1/auth/otp/request",
      "/api/v1/auth/otp/verify",
      "/api/v1/blocks",
      "/api/v1/blocks/{userId}",
      "/api/v1/catalog",
      "/api/v1/config",
      "/api/v1/games",
      "/api/v1/games/types/{type}/rules",
      "/api/v1/games/{id}",
      "/api/v1/games/{id}/accept",
      "/api/v1/games/{id}/actions",
      "/api/v1/games/{id}/add-player",
      "/api/v1/games/{id}/cancel",
      "/api/v1/games/{id}/decline",
      "/api/v1/games/{id}/history",
      "/api/v1/games/{id}/join-link",
      "/api/v1/games/{id}/preview",
      "/api/v1/games/{id}/rematch",
      "/api/v1/games/{id}/remove-seat",
      "/api/v1/games/{id}/resign",
      "/api/v1/games/{id}/seen",
      "/api/v1/games/{id}/start",
      "/api/v1/health",
      "/api/v1/join",
      "/api/v1/join/lookup",
      "/api/v1/me",
      "/api/v1/me/delete/otp",
      "/api/v1/me/under-age",
      "/api/v1/players/recent",
      "/api/v1/push/subscriptions",
    ]);
  });
});

describe("server-handled paths", () => {
  it.each(["/api/nope", "/api/v1/nope", "/api/v2/health", "/__dev/emails"])(
    "%s is a JSON 404, never the SPA",
    async (path) => {
      const { app } = setup();
      for (const method of ["GET", "POST"]) {
        const res = await app.request(path, { method });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found." } });
      }
    },
  );
});

describe("/manifest.webmanifest", () => {
  it("is generated from APP_NAME and APP_SHORT_NAME at runtime", async () => {
    const { app } = setup({ ...PROD_ENV, APP_NAME: "Family Games", APP_SHORT_NAME: "Games" });
    const res = await app.request("/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/manifest+json");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    const manifest = (await res.json()) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: "Family Games",
      short_name: "Games",
      display: "standalone",
      start_url: "/",
      scope: "/",
    });
    expect(manifest["icons"]).toHaveLength(3);
  });

  it("answers anything but GET with a JSON 404", async () => {
    const { app } = setup();
    expect((await app.request("/manifest.webmanifest", { method: "POST" })).status).toBe(404);
  });
});

describe("headers", () => {
  it.each(["/api/health", "/api/v1/health", "/api/v1/config", "/api/nope"])(
    "%s carries the security headers and no-store",
    async (path) => {
      const { app } = setup();
      const res = await app.request(path);
      for (const [name, value] of Object.entries(
        securityHeaders({ hsts: true, turnstile: false }),
      )) {
        expect(res.headers.get(name)).toBe(value);
      }
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    },
  );

  it("omits HSTS for a local-dev http origin", async () => {
    const { app } = setup({
      ...PROD_ENV,
      PUBLIC_URL: "http://localhost:8080",
      APP_SECRET: PROD_ENV["APP_SECRET"],
    });
    const res = await app.request("/api/health");
    expect(res.headers.has("Strict-Transport-Security")).toBe(false);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("refuses Turnstile keys until enforcement exists, so no CSP is widened (M2b review S-3)", () => {
    expect(() => setup({ ...PROD_ENV, TURNSTILE_SITE_KEY: "k", TURNSTILE_SECRET: "s" })).toThrow(
      /Turnstile enforcement is not built yet/u,
    );
  });
});

describe("errors and logging", () => {
  it("logs one structured line per request with the route pattern, never the raw path", async () => {
    const { app, platform } = setup();
    await app.request("/api/v1/health?email=someone@example.org");
    expect(platform.lines).toHaveLength(1);
    expect(platform.lines[0]).toMatchObject({
      level: "info",
      msg: "request",
      method: "GET",
      route: "/api/v1/health",
      status: 200,
      durationMs: 0,
    });
    expect(JSON.stringify(platform.lines)).not.toContain("someone@example.org");
    expect(platform.lines[0]?.["requestId"]).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("logs the catch-all pattern for unknown API paths", async () => {
    const { app, platform } = setup();
    await app.request("/api/v1/users/secret-id");
    expect(platform.lines[0]).toMatchObject({ route: "/api/*", status: 404 });
  });

  it("turns an unhandled exception into 500 INTERNAL with no detail, logging the class and request id", async () => {
    const platform = testPlatform();
    // A configuration value that throws when a handler reads it stands in for any handler bug.
    const config = Object.defineProperty({ ...platform.config }, "operatorContact", {
      get(): never {
        throw new TypeError("kaboom");
      },
    });
    const app = createApp({
      platform: { ...platform, config },
      games: [],
      onboardingClaims: 8,
      blockLobbies: 6,
    });
    const failed = await app.request("/api/v1/config");
    expect(failed.status).toBe(500);
    const body = await failed.text();
    expect(JSON.parse(body)).toEqual({
      error: { code: "INTERNAL", message: "Something went wrong." },
    });
    expect(body).not.toContain("kaboom");
    expect(failed.headers.get("Content-Security-Policy")).not.toBeNull();
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    const errorLine = platform.lines.find((line) => line["level"] === "error");
    expect(errorLine).toMatchObject({
      msg: "unhandled error",
      errorClass: "TypeError",
      route: "/api/v1/config",
    });
    expect(errorLine?.["requestId"]).toEqual(expect.any(String));
  });

  /** An app whose /api/v1/config handler throws `error` (reading config is its first step). */
  function throwing(error: Error) {
    const platform = testPlatform();
    const config = Object.defineProperty({ ...platform.config }, "operatorContact", {
      get(): never {
        throw error;
      },
    });
    return {
      platform,
      app: createApp({
        platform: { ...platform, config },
        games: [],
        onboardingClaims: 8,
        blockLobbies: 6,
      }),
    };
  }

  it.each([
    [400, "BAD_REQUEST"],
    [401, "UNAUTHENTICATED"],
    [404, "NOT_FOUND"],
    [413, "TOO_LARGE"],
    [415, "UNSUPPORTED_MEDIA_TYPE"],
    [429, "RATE_LIMITED"],
  ])(
    "passes an HTTPException with status %i through as %s, logged below error level",
    async (status, code) => {
      const { app, platform } = throwing(
        new HTTPException(status as ContentfulStatusCode, { message: "input: secret-value" }),
      );
      const res = await app.request("/api/v1/config");
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({
        error: { code, message: "The request was rejected." },
      });
      expect(platform.lines.some((line) => line["level"] === "error")).toBe(false);
      const rejected = platform.lines.find((line) => line["msg"] === "request rejected");
      expect(rejected).toMatchObject({ level: "info", status, errorClass: "Error" });
      expect(String(rejected?.["stack"])).toMatch(/^\s+at /u);
      expect(JSON.stringify(platform.lines)).not.toContain("secret-value");
    },
  );

  it.each([
    ["an HTTPException with a 5xx status", new HTTPException(503, { message: "upstream" })],
    ["an HTTPException with an unmapped status", new HTTPException(409, { message: "conflict" })],
    ["a SyntaxError (stored JSON, an engine bug)", new SyntaxError("Unexpected token in JSON")],
  ])("treats %s as a server fault: 500 INTERNAL, logged at error level", async (_, error) => {
    const { app, platform } = throwing(error);
    const res = await app.request("/api/v1/config");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "INTERNAL", message: "Something went wrong." },
    });
    expect(platform.lines.find((line) => line["level"] === "error")).toMatchObject({
      msg: "unhandled error",
      errorClass: error.name,
    });
    expect(platform.lines.some((line) => line["msg"] === "request rejected")).toBe(false);
  });

  it("logs a JSON.parse failure without its message, which quotes the text being parsed", async () => {
    let parseError: unknown;
    try {
      // V8 quotes short input whole: Unexpected token 's', "secretval" is not valid JSON.
      JSON.parse("secretval");
    } catch (error) {
      parseError = error;
    }
    expect(parseError).toBeInstanceOf(SyntaxError);
    expect(String(parseError)).toContain("secretval");
    const { app, platform } = throwing(parseError as SyntaxError);
    expect((await app.request("/api/v1/config")).status).toBe(500);
    const logged = platform.lines.find((line) => line["level"] === "error");
    expect(logged).toMatchObject({ msg: "unhandled error", errorClass: "SyntaxError" });
    expect(String(logged?.["stack"])).toMatch(/^\s+at /u);
    expect(JSON.stringify(platform.lines)).not.toContain("secretval");
  });

  it("keeps no line of a multi-line message, even one that looks like a stack frame", async () => {
    let parseError: unknown;
    try {
      // V8 quotes the input with its newlines, so the message's second line reads like a frame.
      JSON.parse("x\n    at SECRET1");
    } catch (error) {
      parseError = error;
    }
    expect(String((parseError as Error).stack)).toContain("\n    at SECRET1");
    const { app, platform } = throwing(parseError as SyntaxError);
    expect((await app.request("/api/v1/config")).status).toBe(500);
    const logged = platform.lines.find((line) => line["level"] === "error");
    expect(String(logged?.["stack"])).toMatch(/^\s+at /u);
    expect(JSON.stringify(platform.lines)).not.toContain("SECRET1");
  });

  it("keeps no stack at all when the stack doesn't start with the error's own text", async () => {
    const error = new SyntaxError("message");
    error.stack = "SyntaxError: other\n    at SECRET2 (file.js:1:1)";
    const { app, platform } = throwing(error);
    expect((await app.request("/api/v1/config")).status).toBe(500);
    expect(platform.lines.find((line) => line["level"] === "error")).toMatchObject({ stack: "" });
    expect(JSON.stringify(platform.lines)).not.toContain("SECRET2");
  });

  it("rejects a malformed JSON body as 400 BAD_REQUEST: Hono's validator raises an HTTPException", async () => {
    const { app, platform } = setup();
    app.openapi(
      createRoute({
        method: "post",
        path: "/echo", // outside the server paths, whose catch-all answers 404 first
        request: {
          body: { content: { "application/json": { schema: z.object({ a: z.string() }) } } },
        },
        responses: { 200: { description: "ok" } },
      }),
      (c) => c.body(null, 200),
    );
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a": "secret-value"',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(platform.lines.some((line) => line["level"] === "error")).toBe(false);
    expect(JSON.stringify(platform.lines)).not.toContain("secret-value");
  });

  it("measures request duration with the platform clock", async () => {
    const platform = testPlatform();
    let calls = 0;
    const now = (): Date => new Date(Date.UTC(2026, 0, 1) + 25 * calls++);
    const app = createApp({
      platform: { ...platform, now },
      games: [],
      onboardingClaims: 8,
      blockLobbies: 6,
    });
    await app.request("/api/v1/health");
    expect(platform.lines.at(-1)).toMatchObject({ durationMs: 25 });
  });

  describe("the error code in the request log line (09 §5)", () => {
    const OTP = "/api/v1/auth/otp/request";
    const PLANTED = "planted-7f3a91c2";
    const post = (body: string, headers: Record<string, string> = {}) => ({
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    const requestLine = (lines: Record<string, unknown>[]) =>
      lines.filter((line) => line["msg"] === "request");

    it("carries the code of an ApiError", async () => {
      const { app, platform } = throwing(ApiError.of("NOT_FOUND"));
      expect((await app.request("/api/v1/config")).status).toBe(404);
      const lines = requestLine(platform.lines);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ status: 404, code: "NOT_FOUND" });
    });

    it("carries a game module's own code", async () => {
      const { app, platform } = throwing(ApiError.module("WORD_NOT_FOUND", { word: PLANTED }));
      expect((await app.request("/api/v1/config")).status).toBe(400);
      expect(requestLine(platform.lines)[0]).toMatchObject({ code: "WORD_NOT_FOUND" });
    });

    it("carries INTERNAL for an unhandled exception, without the message", async () => {
      const { app, platform } = throwing(new TypeError(PLANTED));
      await app.request("/api/v1/config");
      expect(requestLine(platform.lines)[0]).toMatchObject({ status: 500, code: "INTERNAL" });
    });

    it("logs a validation failure's issue paths and codes, never values", async () => {
      const { app, platform } = setup();
      const res = await app.request(OTP, post(JSON.stringify({ email: PLANTED.repeat(30) })));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
      const lines = requestLine(platform.lines);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        status: 400,
        code: "BAD_REQUEST",
        route: OTP,
        issues: "json.email:too_big",
      });
      expect(JSON.stringify(platform.lines)).not.toContain(PLANTED);
    });

    it("tells an address the handler refuses from a validation failure by its reason", async () => {
      const { app, platform } = setup();
      const res = await app.request(OTP, post(JSON.stringify({ email: `${PLANTED}@nodot` })));
      expect(res.status).toBe(400);
      const line = requestLine(platform.lines)[0];
      expect(line).toMatchObject({ code: "BAD_REQUEST", reason: "invalid_email" });
      expect(line).not.toHaveProperty("issues");
      expect(JSON.stringify(platform.lines)).not.toContain(PLANTED);
    });

    it("logs an unknown key as an issue without naming the key", async () => {
      const { app, platform } = setup();
      await app.request(OTP, post(JSON.stringify({ email: "a@example.org", [PLANTED]: 1 })));
      expect(requestLine(platform.lines)[0]).toMatchObject({ issues: "json:unrecognized_keys" });
      expect(JSON.stringify(platform.lines)).not.toContain(PLANTED);
    });

    it("logs a body of the wrong shape by path and code", async () => {
      const { app, platform } = setup();
      await app.request(OTP, post(JSON.stringify({ email: 42 })));
      expect(requestLine(platform.lines)[0]).toMatchObject({ issues: "json.email:invalid_type" });
    });

    it("carries the code of a JSON-rule refusal", async () => {
      const { app, platform } = setup();
      const res = await app.request(OTP, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: PLANTED,
      });
      expect(res.status).toBe(415);
      expect(requestLine(platform.lines)[0]).toMatchObject({
        status: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
      });
      expect(JSON.stringify(platform.lines)).not.toContain(PLANTED);
    });

    it("carries the code of an Origin refusal", async () => {
      const { app, platform } = setup();
      const res = await app.request(OTP, post("{}", { Origin: "https://evil.example" }));
      expect(res.status).toBe(403);
      expect(requestLine(platform.lines)[0]).toMatchObject({ status: 403, code: "BAD_ORIGIN" });
    });

    it("carries the code of a body-limit refusal", async () => {
      const { app, platform } = setup();
      const res = await app.request(OTP, post(JSON.stringify({ email: "a".repeat(20_000) })));
      expect(res.status).toBe(413);
      expect(requestLine(platform.lines)[0]).toMatchObject({ status: 413, code: "TOO_LARGE" });
    });

    it("carries the code of unparseable JSON", async () => {
      const { app, platform } = setup();
      const res = await app.request(OTP, post(`{"email": "${PLANTED}"`));
      expect(res.status).toBe(400);
      expect(requestLine(platform.lines)[0]).toMatchObject({ status: 400, code: "BAD_REQUEST" });
      expect(JSON.stringify(platform.lines)).not.toContain(PLANTED);
    });

    it("carries the code of a missing client address, with a fixed reason", async () => {
      const platform = testPlatform(PROD_ENV);
      const app = createApp({
        platform: { ...platform, clientIp: () => ({ ok: false, reason: "missing" }) },
        games: [],
        onboardingClaims: 8,
        blockLobbies: 6,
      });
      const res = await app.request(OTP, post(JSON.stringify({ email: "a@example.org" })));
      expect(res.status).toBe(400);
      expect(requestLine(platform.lines)[0]).toMatchObject({
        code: "BAD_REQUEST",
        reason: "no_client_ip",
      });
      expect(JSON.stringify(platform.lines)).not.toContain("a@example.org");
    });

    describe("session-gate refusals", () => {
      const ME = "/api/v1/me";
      const NOW = Date.UTC(2026, 0, 1);
      const TOKEN = "stale-token".padEnd(43, "x");
      const COOKIE = { Cookie: `__Host-sid=${TOKEN}` };

      it.each([
        ["no cookie", {}, 401, "UNAUTHENTICATED"],
        ["a bearer token alone", { Authorization: "Bearer x" }, 401, "UNAUTHENTICATED"],
        [
          "a cookie and a bearer token",
          { ...COOKIE, Authorization: "Bearer x" },
          400,
          "BAD_REQUEST",
        ],
      ])("carries the code for %s", async (_, headers, status, code) => {
        const { app, platform } = setup();
        const res = await app.request(ME, { headers });
        expect(res.status).toBe(status);
        expect(requestLine(platform.lines)[0]).toMatchObject({ status, code });
        expect(JSON.stringify(platform.lines)).not.toContain(TOKEN);
      });

      it("carries the code for a stale cookie", async () => {
        const { app, platform } = signedInAs(null);
        const res = await app.request(ME, { headers: COOKIE });
        expect(res.status).toBe(401);
        expect(requestLine(platform.lines)[0]).toMatchObject({ code: "UNAUTHENTICATED" });
      });

      /** An app whose session cookie resolves to a stored user with these fields. */
      function signedInAs(user: Record<string, unknown> | null) {
        const platform = testPlatform(PROD_ENV);
        const repos = {
          ...platform.repos,
          // Account writes count toward the per-user write limit (A21-S-3): always under it here.
          rateLimits: {
            hit: (hits: readonly unknown[]) =>
              Promise.resolve(hits.map(() => ({ current: 1, previous: 0 }))),
          },
          sessions: {
            ...platform.repos.sessions,
            findByTokenHash: () =>
              Promise.resolve(
                user === null
                  ? null
                  : {
                      session: {
                        id: "s",
                        createdAt: NOW,
                        lastSeenAt: NOW,
                        expiresAt: Number.MAX_SAFE_INTEGER,
                      },
                      user: { id: "u", suspendedAt: null, ...user },
                    },
              ),
          },
        };
        return {
          platform,
          app: createApp({
            platform: { ...platform, repos } as never,
            games: [],
            onboardingClaims: 8,
            blockLobbies: 6,
          }),
        };
      }

      it("carries SUSPENDED for a suspended account", async () => {
        const { app, platform } = signedInAs({ suspendedAt: 1 });
        const res = await app.request(ME, { headers: COOKIE });
        expect(res.status).toBe(403);
        expect(requestLine(platform.lines)[0]).toMatchObject({ status: 403, code: "SUSPENDED" });
      });

      it("gives requesting a deletion code for an account without an address the reason no_email", async () => {
        const { app, platform } = signedInAs({ email: null, onboardedAt: 1 });
        const res = await app.request("/api/v1/me/delete/otp", {
          method: "POST",
          headers: { ...COOKIE, Origin: "https://play.example.org" },
        });
        expect(res.status).toBe(400);
        expect(requestLine(platform.lines)[0]).toMatchObject({
          code: "BAD_REQUEST",
          reason: "no_email",
        });
      });

      it("gives turning nudges on for an account without an address the reason no_email", async () => {
        // Onboarded for the current MIN_AGE: nudges are refused before onboarding (A21-S-1).
        const { app, platform } = signedInAs({
          email: null,
          displayName: "Sam",
          onboardedAt: 1,
          ageAttestedAt: 1,
          ageAttestedMinAge: 13,
        });
        const res = await app.request(ME, {
          method: "PATCH",
          headers: {
            ...COOKIE,
            "Content-Type": "application/json",
            Origin: "https://play.example.org",
          },
          body: JSON.stringify({ settings: { emailNudges: true } }),
        });
        expect(res.status).toBe(400);
        expect(requestLine(platform.lines)[0]).toMatchObject({
          code: "BAD_REQUEST",
          reason: "no_email",
        });
      });
    });

    it("never logs an identifier-shaped unknown key of a strict object", async () => {
      const { app, platform } = setup();
      const key = "planted_key_9c1e";
      await app.request(OTP, post(JSON.stringify({ email: "a@example.org", [key]: 1 })));
      expect(requestLine(platform.lines)[0]).toMatchObject({ issues: "json:unrecognized_keys" });
      expect(JSON.stringify(platform.lines)).not.toContain(key);
    });

    it("leaves a successful request without a code", async () => {
      const { app, platform } = setup();
      await app.request("/api/v1/health");
      expect(requestLine(platform.lines)[0]).not.toHaveProperty("code");
    });
  });

  describe("loggedIssues", () => {
    it("caps the count and masks keys that could carry input", () => {
      const issues = Array.from({ length: 9 }, () => ({
        path: ["items", 3, "someone@example.org"],
        code: "invalid_type",
      }));
      const logged = loggedIssues("json", issues);
      expect(logged.split(",")).toHaveLength(5);
      expect(logged).toContain("json.items.3.*:invalid_type");
      expect(logged).not.toContain("someone");
    });

    it("drops an issue code that is not a plain Zod code", () => {
      expect(loggedIssues("query", [{ path: [], code: "custom code with spaces" }])).toBe(
        "query:unknown",
      );
    });
  });
});

describe("createJsonLogger", () => {
  it("drops entries below the configured level", () => {
    const lines: string[] = [];
    const log = createJsonLogger({
      level: "warn",
      sink: (line) => lines.push(line),
      now: () => new Date(0),
    });
    log.debug("d");
    log.info("i");
    log.warn("w", { a: 1 });
    log.error("e");
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { a: 1, time: "1970-01-01T00:00:00.000Z", level: "warn", msg: "w" },
      { time: "1970-01-01T00:00:00.000Z", level: "error", msg: "e" },
    ]);
  });

  it("never lets fields overwrite the level, message or time", () => {
    const lines: string[] = [];
    const log = createJsonLogger({
      level: "debug",
      sink: (l) => lines.push(l),
      now: () => new Date(0),
    });
    log.info("real", { msg: "fake", level: "error", time: "x" });
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      msg: "real",
      level: "info",
      time: "1970-01-01T00:00:00.000Z",
    });
  });
});
