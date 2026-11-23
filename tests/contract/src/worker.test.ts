/**
 * The contract suite against the Worker build (`wrangler deploy --dry-run` output) running in
 * workerd through Wrangler's test harness, including Workers Static Assets with the generated
 * `_headers` file — the Cloudflare half of the header test (03 §9, 10 M0).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "wrangler";

import { CONTRACT_SECRETS, CONTRACT_VARS } from "./env.js";
import { contractSuite, expectSecurityHeaders } from "./suite.js";

const WORKER_DIR = new URL("../../../apps/worker/", import.meta.url);

let harness: TestHarness;

/**
 * Why workerd can't start here, if the reason is known: on x86-64 it needs SSE4.2 (x86-64-v2), and
 * without it fails at isolate bootstrap with an empty `jsg.Error` (M0 review CI-1). A VM on the
 * generic `qemu64` CPU model lacks it.
 */
function knownStartupProblem(): string | null {
  if (process.platform !== "linux" || process.arch !== "x64") return null;
  const cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
  const flags = /^flags\s*:(.*)$/mu.exec(cpuinfo)?.[1]?.split(" ") ?? [];
  if (flags.includes("sse4_2")) return null;
  const model = /^model name\s*:\s*(.*)$/mu.exec(cpuinfo)?.[1] ?? "unknown";
  return `workerd needs SSE4.2 (x86-64-v2) and this CPU (${model}) doesn't offer it; run the Worker tests on a host or VM CPU type that does`;
}

beforeAll(async () => {
  harness = createTestHarness({
    root: fileURLToPath(WORKER_DIR),
    workers: [
      {
        configPath: "wrangler.example.toml",
        prebuiltWorkerDir: "dist/worker",
        vars: CONTRACT_VARS,
        secrets: CONTRACT_SECRETS,
      },
    ],
  });
  try {
    await harness.listen();
  } catch (error) {
    // Print the harness's server events and workerd's own logs leading up to the failure, without
    // letting a problem printing them hide the original error.
    try {
      harness.debug();
    } catch (debugError) {
      console.error("harness.debug() failed", debugError);
    }
    // Naming a known cause is a courtesy: a problem reading the CPU's flags mustn't hide the error.
    let known: string | null = null;
    try {
      known = knownStartupProblem();
    } catch (probeError) {
      console.error("knownStartupProblem() failed", probeError);
    }
    throw known === null ? error : new Error(known, { cause: error });
  }
}, 60_000);

afterAll(async () => {
  await harness.close();
});

/** Statuses whose responses have no body. */
const NULL_BODY = new Set([101, 204, 205, 304]);

/**
 * Sends a request through the harness. Its fetch takes a URL and init, and answers with
 * Miniflare's own Response class, so both are converted at this boundary.
 */
async function send(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: ArrayBuffer } = {},
): Promise<Response> {
  const answer = await harness.fetch(path, init);
  return new Response(NULL_BODY.has(answer.status) ? null : await answer.arrayBuffer(), {
    status: answer.status,
    headers: Object.fromEntries(answer.headers),
  });
}

contractSuite("Worker", () => ({
  fetch: async (request) => {
    const url = new URL(request.url);
    return send(url.pathname + url.search, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      ...(request.body ? { body: await request.arrayBuffer() } : {}),
    });
  },
}));

describe("Worker static assets (generated _headers)", () => {
  const asset = readdirSync(new URL("dist/assets/assets/", WORKER_DIR)).find((file) =>
    file.endsWith(".js"),
  );

  it.each(["/", "/index.html", "/g/some-game"])(
    "GET %s serves the shell with the shared security headers",
    async (path) => {
      const response = await send(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toMatch(/^text\/html/u);
      expectSecurityHeaders(response);
      expect(response.headers.get("Cache-Control")).not.toMatch(/immutable/u);
    },
  );

  it("serves hashed assets as immutable, with the security headers", async () => {
    expect(asset).toBeDefined();
    const response = await send(`/assets/${asset ?? ""}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expectSecurityHeaders(response);
  });

  it("never serves the shell for server paths", async () => {
    for (const path of ["/api/nope", "/__dev/emails", "/manifest.webmanifest"]) {
      const response = await send(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("Content-Type")).toMatch(/^application\/json/u);
    }
  });
});
