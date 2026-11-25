/**
 * The API contract suite (docs/spec/05-api.md §Versioning, 11 §4): written against
 * `@your-move/api-client` and run unchanged against every runtime build.
 */
import { readFileSync } from "node:fs";

import { createApiClient } from "@your-move/api-client";
import { securityHeaders } from "@your-move/server";
import { ClientConfigSchema, ErrorResponseSchema } from "@your-move/shared";
import { describe, expect, it } from "vitest";

export interface Target {
  /** Sends a request to the runtime under test. */
  fetch(request: Request): Promise<Response>;
}

/** Every runtime is configured with an https PUBLIC_URL and no Turnstile. */
const EXPECTED_HEADERS = securityHeaders({ hsts: true, turnstile: false });

const COMMITTED_DOCUMENT: unknown = JSON.parse(
  readFileSync(new URL("../../../packages/api-client/openapi/v1.json", import.meta.url), "utf8"),
);

/**
 * The client address as Cloudflare would set it (08 §4.1). The Worker needs it on IP-using routes;
 * the Node build (TRUST_PROXY=false) ignores it and uses the socket address.
 */
const CLIENT_IP = { "CF-Connecting-IP": "203.0.113.10" } as const;

export function expectSecurityHeaders(response: Response): void {
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
    expect(response.headers.get(name), name).toBe(value);
  }
}

export function contractSuite(name: string, target: () => Target): void {
  const client = () =>
    createApiClient({
      baseUrl: "http://contract.test",
      fetch: (request: Request) => target().fetch(request),
    });
  const raw = (path: string) => target().fetch(new Request(new URL(path, "http://contract.test")));

  describe(`API contract: ${name}`, () => {
    it("GET /api/v1/health answers { ok: true }, uncached, with the security headers", async () => {
      const { data, response } = await client().GET("/api/v1/health");
      expect(response.status).toBe(200);
      expect(data).toEqual({ ok: true });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expectSecurityHeaders(response);
    });

    it("GET /api/health answers unversioned", async () => {
      const response = await raw("/api/health");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });

    it("GET /api/v1/config returns exactly the public configuration schema", async () => {
      const { data, response } = await client().GET("/api/v1/config");
      expect(response.status).toBe(200);
      expect(ClientConfigSchema.parse(data)).toEqual(data);
    });

    describe("games (05 §Games)", () => {
      it("serves a game type's rules publicly", async () => {
        const { data, response } = await client().GET("/api/v1/games/types/{type}/rules", {
          params: { path: { type: "words" } },
        });
        expect(response.status).toBe(200);
        expect(data?.type).toBe("words");
        expect(data?.markdown.length).toBeGreaterThan(0);
        const unknown = await raw("/api/v1/games/types/nope/rules");
        expect(unknown.status).toBe(404);
      });

      it.each(["/api/v1/catalog", "/api/v1/games", `/api/v1/games/${crypto.randomUUID()}`])(
        "GET %s needs a session",
        async (path) => {
          const response = await raw(path);
          expect(response.status).toBe(401);
          expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe(
            "UNAUTHENTICATED",
          );
        },
      );

      it("serves the built-in word lists to clients by their versioned, hashed names", async () => {
        const index = JSON.parse(
          readFileSync(
            new URL("../../../packages/dictionary/generated/served/index.json", import.meta.url),
            "utf8",
          ),
        ) as {
          dictionaries: { id: string; version: number; wordsSha256: string; bytes: number }[];
        };
        const manifest = index.dictionaries[0];
        expect(manifest).toBeDefined();
        if (manifest === undefined) return;
        const name = `${manifest.id}-v${String(manifest.version)}.${manifest.wordsSha256.slice(0, 16)}.txt`;
        const response = await raw(`/assets/dictionaries/${name}`);
        expect(response.status).toBe(200);
        expect((await response.text()).length).toBe(manifest.bytes);
        expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      });
    });

    it("GET /api/v1/openapi.json serves the committed document", async () => {
      const response = await raw("/api/v1/openapi.json");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(COMMITTED_DOCUMENT);
    });

    describe("sign-in (06 §3–§4)", () => {
      /** A request as a browser on another site, or a script, would send it. */
      const send = (
        path: string,
        init: { method: string; body?: string; headers?: Record<string, string> },
      ) =>
        target().fetch(
          new Request(new URL(path, "http://contract.test"), {
            method: init.method,
            headers: { ...CLIENT_IP, ...init.headers },
            ...(init.body === undefined ? {} : { body: init.body }),
          }),
        );
      const json = { "Content-Type": "application/json" };

      it("POST /api/v1/auth/otp/request answers 202 {}", async () => {
        const { data, response } = await client().POST("/api/v1/auth/otp/request", {
          body: { email: `contract-${crypto.randomUUID()}@example.org` },
          headers: CLIENT_IP,
        });
        expect(response.status).toBe(202);
        expect(data).toEqual({});
      });

      it("POST /api/v1/auth/otp/verify with a wrong code answers 400 INVALID_CODE", async () => {
        const { error, response } = await client().POST("/api/v1/auth/otp/verify", {
          body: { email: `contract-${crypto.randomUUID()}@example.org`, code: "12345678" },
          headers: CLIENT_IP,
        });
        expect(response.status).toBe(400);
        expect(error?.error.code).toBe("INVALID_CODE");
      });

      it("GET /api/v1/me without a session answers 401", async () => {
        const { error, response } = await client().GET("/api/v1/me");
        expect(response.status).toBe(401);
        expect(error?.error.code).toBe("UNAUTHENTICATED");
      });

      it("a cookie request without this instance's Origin answers 403 BAD_ORIGIN", async () => {
        const response = await send("/api/v1/auth/logout", {
          method: "POST",
          body: "{}",
          headers: { ...json, Cookie: `__Host-sid=${"A".repeat(43)}` },
        });
        expect(response.status).toBe(403);
        expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe("BAD_ORIGIN");
      });

      it("a body that isn't JSON answers 415", async () => {
        const response = await send("/api/v1/auth/otp/request", {
          method: "POST",
          body: "email=a@example.org",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        expect(response.status).toBe(415);
      });

      it("GET /__dev/emails answers 404 in a production config (08 T19)", async () => {
        const response = await raw("/__dev/emails");
        expect(response.status).toBe(404);
      });
    });

    it("answers unknown API paths with a JSON 404 error", async () => {
      const response = await raw("/api/v1/does-not-exist");
      expect(response.status).toBe(404);
      expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe("NOT_FOUND");
      expectSecurityHeaders(response);
    });
  });
}
