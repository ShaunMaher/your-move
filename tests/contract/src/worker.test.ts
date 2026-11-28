/**
 * The contract suite against the Worker build (`wrangler deploy --dry-run` output) running in
 * workerd through Wrangler's test harness, including Workers Static Assets with the generated
 * `_headers` file — the Cloudflare half of the header test (03 §9, 10 M0).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { normaliseAddress } from "@your-move/server";
import { d1Repositories } from "@your-move/worker/d1";
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
  // The Worker runs against the same schema a deployment has (M2a review P-9).
  await harness.getWorker().applyD1Migrations("DB");
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
  // The Worker's own D1 binding, through the harness.
  repos: async () => {
    const env = (await harness.getWorker().getEnv()) as {
      DB: Parameters<typeof d1Repositories>[0];
    };
    return d1Repositories(env.DB);
  },
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
  it("keeps the dictionaries' index out of the immutable assets, and no precompressed copies (A2 review S-8)", async () => {
    const index = await send("/dictionaries/index.json");
    expect(index.status).toBe(200);
    expect(index.headers.get("Cache-Control") ?? "").not.toMatch(/immutable/u);
    const manifest = (
      JSON.parse(await index.text()) as {
        dictionaries: { id: string; version: number; wordsSha256: string }[];
      }
    ).dictionaries[0];
    const name = `${manifest?.id ?? ""}-v${String(manifest?.version)}.${manifest?.wordsSha256.slice(0, 16) ?? ""}.txt`;
    expect((await send(`/assets/dictionaries/${name}`)).status).toBe(200);
    // Neither is published under /assets/ (a missing path there gets the SPA's answer).
    for (const path of [`/assets/dictionaries/${name}.gz`, "/assets/dictionaries/index.json"]) {
      const response = await send(path, { headers: { "Sec-Fetch-Mode": "cors" } });
      expect(response.headers.get("Content-Type"), path).toMatch(/^text\/html/u);
    }
    expect(readdirSync(new URL("dist/assets/assets/dictionaries/", WORKER_DIR)).sort()).toEqual([
      name,
    ]);
  });

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
    for (const path of ["/api/nope", "/__dev/emails"]) {
      const response = await send(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("Content-Type")).toMatch(/^application\/json/u);
    }
  });

  it("generates the manifest from config in the Worker, not from the static assets", async () => {
    const response = await send("/manifest.webmanifest");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/manifest+json");
    expectSecurityHeaders(response);
  });
});

describe("Worker storage", () => {
  it("runs on a D1 database with the shared migrations applied", async () => {
    const env = await harness
      .getWorker<{ DB: { prepare(sql: string): { first<T>(): Promise<T | null> } } }>()
      .getEnv();
    const row = await env.DB.prepare(
      "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name IN ('users', 'games', 'game_players')",
    ).first<{ n: number }>();
    expect(row?.n).toBe(3);
  });
});

describe("Worker Cron Trigger (03 §8, alpha A6)", () => {
  it("runs the sweep, which claims a due email nudge", async () => {
    const env = (await harness.getWorker().getEnv()) as {
      DB: Parameters<typeof d1Repositories>[0];
    };
    const repos = d1Repositories(env.DB);
    const db = env.DB as unknown as { prepare(sql: string): { first<T>(): Promise<T | null> } };
    const userId = crypto.randomUUID();
    const email = normaliseAddress(`cron-${userId}@example.org`);
    if (email === null) throw new Error("bad address");
    const long = Date.now() - 2 * 24 * 60 * 60 * 1000;
    await repos.users.create({
      id: userId,
      email,
      displayName: "Cron",
      onboardedAt: long,
      createdAt: long,
      updatedAt: long,
    });
    await repos.users.setEmailNudges(userId, {
      enabled: true,
      emailId: "c".repeat(64),
      updatedAt: long,
    });
    const gameId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    await repos.games.create(
      {
        id: gameId,
        gameType: "example",
        gameVersion: 1,
        options: "{}",
        status: "active",
        seats: 2,
        turnTimeoutDays: 3,
        seatOrder: "join",
        aiAssistance: "off",
        state: "{}",
        lastActionAt: long,
        createdAt: long,
        updatedAt: long,
        startedAt: long,
      },
      [
        {
          id: playerId,
          userId,
          seat: 0,
          state: "playing",
          joinedAt: long,
          toAct: 1,
          toActSince: long,
        },
        { id: crypto.randomUUID(), seat: 1, state: "playing", joinedAt: long },
      ],
    );
    // An invocation is "ok" only when every sweep step ran and no nudge failed (apps/worker).
    const result = await harness
      .getWorker()
      .scheduled({ scheduledTime: new Date(), cron: "*/15 * * * *" });
    expect(result.outcome).toBe("ok");
    // The nudge was counted against the daily cap, then claimed: the whole send path ran.
    const counted = await db
      .prepare("SELECT sum(count) AS n FROM rate_limits WHERE key = 'NUDGE_EMAILS_PER_DAY:all'")
      .first<{ n: number }>();
    expect(counted?.n).toBe(1);
    const players = await repos.games.players(gameId);
    expect(players.find((row) => row.id === playerId)?.lastNudgedAt).toEqual(expect.any(Number));
  });
});
