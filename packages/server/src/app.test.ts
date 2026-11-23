import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { securityHeaders } from "./http/security-headers.js";
import { createJsonLogger } from "./log.js";
import { PROD_ENV, testPlatform } from "./test-support.js";

function setup(env = PROD_ENV) {
  const platform = testPlatform(env);
  const app = createApp({ platform, games: [] });
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
      VAPID_PUBLIC_KEY: "vapid-public",
      VAPID_PRIVATE_KEY: "vapid-private-secret",
      VAPID_SUBJECT: "mailto:ops@example.org",
      TURNSTILE_SITE_KEY: "site-key",
      TURNSTILE_SECRET: "turnstile-secret",
    });
    const res = await app.request("/api/v1/config");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({
      appName: "Family Games",
      appShortName: "Family Games",
      operatorContact: "ops@example.org",
      minAge: 13,
      vapidPublicKey: "vapid-public",
      turnstileSiteKey: "site-key",
      uploadsEnabled: true,
    });
    expect(body).not.toMatch(/vapid-private-secret|turnstile-secret|smtp:\/\//u);
  });

  it("omits optional keys that are not configured", async () => {
    const { app } = setup();
    const body = (await (await app.request("/api/v1/config")).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("vapidPublicKey");
    expect(body).not.toHaveProperty("turnstileSiteKey");
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
    expect(Object.keys(doc.paths).sort()).toEqual(["/api/v1/config", "/api/v1/health"]);
  });
});

describe("server-handled paths", () => {
  it.each([
    "/api/nope",
    "/api/v1/nope",
    "/api/v2/health",
    "/__dev/emails",
    "/manifest.webmanifest",
  ])("%s is a JSON 404, never the SPA", async (path) => {
    const { app } = setup();
    for (const method of ["GET", "POST"]) {
      const res = await app.request(path, { method });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found." } });
    }
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

  it("adds the Turnstile origin to the CSP when Turnstile is configured", async () => {
    const { app } = setup({ ...PROD_ENV, TURNSTILE_SITE_KEY: "k", TURNSTILE_SECRET: "s" });
    const res = await app.request("/api/health");
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "https://challenges.cloudflare.com",
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
    const app = createApp({ platform: { ...platform, config }, games: [] });
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

  it("measures request duration with the platform clock", async () => {
    const platform = testPlatform();
    let calls = 0;
    const now = (): Date => new Date(Date.UTC(2026, 0, 1) + 25 * calls++);
    const app = createApp({ platform: { ...platform, now }, games: [] });
    await app.request("/api/v1/health");
    expect(platform.lines.at(-1)).toMatchObject({ durationMs: 25 });
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
