/**
 * The Cloudflare Worker entry (docs/spec/03-architecture.md §9, 09 §3). Workers Static Assets
 * serve the SPA with the generated `_headers`; this Worker runs first only for the server paths
 * (`run_worker_first` in wrangler.example.toml) and serves the core app.
 */
import {
  ConfigError,
  createApp,
  createJsonLogger,
  installedSchema,
  parseConfig,
  registryMismatches,
} from "@your-move/server";

import installedJson from "../../../generated/installed.json" with { type: "json" };
import { installedGames as games } from "../../../generated/server-registry.js";

type App = ReturnType<typeof createApp>;

/** Builds the app once per isolate from the Worker's vars and secrets. */
function build(env: Readonly<Record<string, unknown>>): App {
  const strings = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const installed = installedSchema.parse(installedJson);
  const mismatches = registryMismatches(games, installed);
  if (mismatches.length > 0) {
    throw new Error(`The game registry does not match installed.json: ${mismatches.join("; ")}`);
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
  return createApp({ platform: { config, log, now }, games });
}

let app: App | null = null;

export default {
  fetch(request, env, ctx) {
    try {
      app ??= build(env);
    } catch (error) {
      // Workers can't refuse to start: log what is wrong (never a value) and answer 500.
      console.error(error instanceof ConfigError ? error.message : "startup failed", {
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
