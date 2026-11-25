/**
 * The Cloudflare Worker entry (docs/spec/03-architecture.md §9, 09 §3). Workers Static Assets
 * serve the SPA with the generated `_headers`; this Worker runs first only for the server paths
 * (`run_worker_first` in wrangler.example.toml) and serves the core app.
 */
import {
  ConfigError,
  coreEmailSender,
  createApp,
  createJsonLogger,
  installedSchema,
  parseConfig,
  registryMismatches,
  resolveClientIp,
} from "@your-move/server";

import installedJson from "../../../generated/installed.json" with { type: "json" };
import { installedGames as games } from "../../../generated/server-registry.js";
import { d1Repositories } from "./d1.js";

type App = ReturnType<typeof createApp>;

/** A startup problem whose message carries no configuration value (safe to log in full). */
class StartupError extends Error {
  override readonly name = "StartupError";
}

/**
 * Builds the app once per isolate from the Worker's vars, secrets and bindings. Nothing
 * request-scoped is captured here: background work goes through each request's own `ctx`
 * (`waitUntil`), which `fetch` below hands to the app.
 */
function build(env: Readonly<Record<string, unknown>>): App {
  const db = env["DB"];
  if (db === undefined || db === null || typeof db !== "object") {
    throw new StartupError("The D1 binding DB is missing (09 §3).");
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
  return createApp({
    platform: {
      repos: d1Repositories(db as D1Database),
      config,
      log,
      now,
      email: coreEmailSender(config, log, now),
      // Workers always sit behind Cloudflare, which sets CF-Connecting-IP (08 §4.1).
      clientIp: (request) =>
        resolveClientIp(request.headers, {
          mode: "cloudflare",
          socketAddress: null,
          hops: 1,
          trustedPeers: [],
        }),
    },
    games,
  });
}

let app: App | null = null;

export default {
  fetch(request, env, ctx) {
    try {
      app ??= build(env);
    } catch (error) {
      // Workers can't refuse to start: log what is wrong and answer 500. ConfigError messages are
      // already redacted and StartupError messages carry no values; anything else is logged by
      // class only, since its message might quote configuration.
      const safe = error instanceof ConfigError || error instanceof StartupError;
      console.error(safe ? error.message : "startup failed", {
        errorClass: error instanceof Error ? error.name : typeof error,
      });
      return Response.json(
        { error: { code: "INTERNAL", message: "Something went wrong." } },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Record<string, unknown>>;
