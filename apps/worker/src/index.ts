/**
 * The Cloudflare Worker entry (docs/spec/03-architecture.md §9, 09 §3). Workers Static Assets
 * serve the SPA with the generated `_headers`; this Worker runs first only for the server paths
 * (`run_worker_first` in wrangler.example.toml) and serves the core app. Its Cron Trigger runs the
 * core's sweep (03 §8).
 */
import {
  ConfigError,
  coreEmailSender,
  corePushSender,
  createApp,
  createJsonLogger,
  createSweep,
  GameConfigError,
  installedSchema,
  parseConfig,
  registryMismatches,
  resolveClientIp,
  ResourceConfigError,
} from "@your-move/server";

import installedJson from "../../../generated/installed.json" with { type: "json" };
import { installedGames as games } from "../../../generated/server-registry.js";
import { d1Repositories } from "./d1.js";
import { assetDictionaries } from "./dictionaries.js";
import { runScheduled } from "./scheduled.js";

interface Built {
  readonly app: ReturnType<typeof createApp>;
  readonly sweep: ReturnType<typeof createSweep>;
}

/** A startup problem whose message carries no configuration value (safe to log in full). */
class StartupError extends Error {
  override readonly name = "StartupError";
}

/**
 * Builds the app once per isolate from the Worker's vars, secrets and bindings. Nothing
 * request-scoped is captured here: background work goes through each request's own `ctx`
 * (`waitUntil`), which `fetch` below hands to the app.
 */
async function build(env: Readonly<Record<string, unknown>>): Promise<Built> {
  const db = env["DB"];
  if (db === undefined || db === null || typeof db !== "object") {
    throw new StartupError("The D1 binding DB is missing (09 §3).");
  }
  const assets = env["ASSETS"];
  if (assets === undefined || assets === null || typeof assets !== "object") {
    throw new StartupError("The static assets binding ASSETS is missing (09 §3).");
  }
  const strings = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const installed = installedSchema.parse(installedJson);
  const mismatches = registryMismatches(games, installed);
  if (mismatches.length > 0) {
    throw new StartupError(
      `The game registry does not match installed.json: ${mismatches.join("; ")}`,
    );
  }
  const config = parseConfig(strings, {
    runtime: "cloudflare",
    installedGames: Object.entries(installed).map(([type, entry]) => ({
      type,
      enabledByDefault: entry.enabledByDefault,
    })),
  });
  const now = (): Date => new Date();
  const log = createJsonLogger({
    level: config.logLevel,
    now,
    sink: (line) => {
      console.log(line);
    },
  });
  const dictionaries = await assetDictionaries(assets as Fetcher);
  const platform = {
    repos: d1Repositories(db as D1Database),
    dictionaries,
    config,
    log,
    now,
    email: coreEmailSender(config, log, now),
    push: corePushSender(config, log, now),
    // Workers always sit behind Cloudflare, which sets CF-Connecting-IP (08 §4.1).
    clientIp: (request: Request) =>
      resolveClientIp(request.headers, {
        mode: "cloudflare",
        socketAddress: null,
        hops: 1,
        trustedPeers: [],
      }),
  };
  return {
    app: createApp({ platform, games }),
    sweep: createSweep({
      platform,
      games,
      nudgesPerRun: WORKER_NUDGES_PER_RUN,
      claimsPerRun: WORKER_CLAIMS_PER_RUN,
      lobbiesPerRun: WORKER_LOBBIES_PER_RUN,
    }),
  };
}

/**
 * What one Cron Trigger invocation does at most (03 §7, §8), inside the Free plan's
 * per-invocation D1 query limit (09 §3 has the arithmetic): one overdue lobby expired (at most 4
 * statements and one per typed address), one email-invite seat claimed (5) and 2 email nudges (10
 * each, and up to 5 per run), 35 for a two-seat game; re-measure at the first Workers deployment
 * (10).
 */
const WORKER_NUDGES_PER_RUN = 2;
const WORKER_CLAIMS_PER_RUN = 1;
const WORKER_LOBBIES_PER_RUN = 1;

let built: Promise<Built> | null = null;

/** The isolate's app and sweep, built on first use; null (logged) if the build failed. */
async function ready(env: Readonly<Record<string, unknown>>): Promise<Built | null> {
  try {
    built ??= build(env);
    return await built;
  } catch (error) {
    // A failed build is retried by the next request (the dictionary index may have been briefly
    // unavailable).
    built = null;
    // Workers can't refuse to start: log what is wrong. ConfigError and the game and resource
    // configuration errors name variables, never values, and StartupError messages carry no
    // values; anything else is logged by class only, since its message might quote configuration.
    const safe =
      error instanceof ConfigError ||
      error instanceof StartupError ||
      error instanceof GameConfigError ||
      error instanceof ResourceConfigError;
    console.error(safe ? error.message : "startup failed", {
      errorClass: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const worker = await ready(env);
    if (worker === null) {
      // Startup failed before the app existed: deliberately outside the request log and the
      // per-request error contract (05 §Errors), which only the app's handlers uphold. The
      // failure was logged by `ready`.
      return Response.json(
        { error: { code: "INTERNAL", message: "Something went wrong." } },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
    return worker.app.fetch(request, env, ctx);
  },
  // The Cron Trigger (`*/15 * * * *`, wrangler.example.toml): one sweep run (03 §8).
  async scheduled(controller, env) {
    await runScheduled(controller, (await ready(env))?.sweep ?? null);
  },
} satisfies ExportedHandler<Record<string, unknown>>;
