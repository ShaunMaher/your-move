import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createJsonLogger,
  detachedRepositories,
  parseConfig,
  securityHeaders,
} from "@your-move/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createNodeApp } from "./server.js";

let staticRoot: string;

beforeAll(() => {
  staticRoot = mkdtempSync(join(tmpdir(), "web-dist-"));
  mkdirSync(join(staticRoot, "assets"));
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>shell</title>");
  writeFileSync(join(staticRoot, "assets", "index-abc123.js"), "console.log(1);");
  writeFileSync(join(staticRoot, "sw.js"), "self;");
});

afterAll(() => {
  rmSync(staticRoot, { recursive: true, force: true });
});

function app() {
  const now = (): Date => new Date(0);
  const config = parseConfig(
    {
      PUBLIC_URL: "https://play.example.org",
      APP_SECRET: btoa("0123456789abcdef0123456789abcdef"),
      EMAIL_PROVIDER: "smtp",
      SMTP_URL: "smtp://mail.example.org",
      EMAIL_FROM: "no-reply@example.org",
      OPERATOR_CONTACT: "ops@example.org",
    },
    { runtime: "node", installedGames: [] },
  );
  return createNodeApp({
    platform: {
      repos: detachedRepositories(),
      config,
      now,
      log: createJsonLogger({ level: "error", now, sink: () => undefined }),
    },
    games: [],
    staticRoot,
  });
}

const HEADERS = securityHeaders({ hsts: true, turnstile: false });

describe("Node static serving", () => {
  it.each([
    ["/", "shell", "no-cache"],
    ["/index.html", "shell", "no-cache"],
    ["/g/123", "shell", "no-cache"],
    ["/sw.js", "self;", "no-cache"],
    ["/assets/index-abc123.js", "console.log(1);", "public, max-age=31536000, immutable"],
  ])("GET %s serves the right file with the shared headers", async (path, body, cacheControl) => {
    const res = await app().request(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(body);
    expect(res.headers.get("Cache-Control")).toBe(cacheControl);
    for (const [name, value] of Object.entries(HEADERS)) expect(res.headers.get(name)).toBe(value);
  });

  it("never serves the SPA for server paths", async () => {
    for (const path of ["/api/nope", "/__dev/emails", "/manifest.webmanifest"]) {
      const res = await app().request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toMatch(/^application\/json/u);
    }
  });

  it("serves the API", async () => {
    const res = await app().request("/api/health");
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers a missing hashed asset with 404, not the shell", async () => {
    const res = await app().request("/assets/missing-000000.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("does not escape the static root", async () => {
    const res = await app().request("/..%2f..%2fetc%2fpasswd");
    expect(await res.text()).not.toContain("root:");
  });
});
