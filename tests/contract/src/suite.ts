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

    it("GET /api/v1/openapi.json serves the committed document", async () => {
      const response = await raw("/api/v1/openapi.json");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(COMMITTED_DOCUMENT);
    });

    it("answers unknown API paths with a JSON 404 error", async () => {
      const response = await raw("/api/v1/does-not-exist");
      expect(response.status).toBe(404);
      expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe("NOT_FOUND");
      expectSecurityHeaders(response);
    });
  });
}
