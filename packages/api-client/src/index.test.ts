import { describe, expect, it } from "vitest";

import { createApiClient } from "./index.js";

describe("createApiClient", () => {
  it("calls the full /api/v1 paths of the document and parses JSON", async () => {
    const seen: string[] = [];
    const client = createApiClient({
      baseUrl: "https://play.example.org",
      fetch: (request: Request) => {
        seen.push(`${request.method} ${request.url}`);
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      },
    });
    const { data, error } = await client.GET("/api/v1/health");
    expect(data).toEqual({ ok: true });
    expect(error).toBeUndefined();
    expect(seen).toEqual(["GET https://play.example.org/api/v1/health"]);
  });

  it("returns the error body for non-2xx answers", async () => {
    const client = createApiClient({
      baseUrl: "https://play.example.org",
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: "INTERNAL", message: "x" } }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    });
    const { data, error } = await client.GET("/api/v1/config");
    expect(data).toBeUndefined();
    expect(error).toEqual({ error: { code: "INTERNAL", message: "x" } });
  });
});
