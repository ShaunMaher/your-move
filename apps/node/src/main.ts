/**
 * The Node entry point (docs/spec/09-operations.md §4). Run with
 * `node --disallow-code-generation-from-strings`. Startup order (02 §7.3, §7.5):
 *
 * 1. read configuration and secrets (`*_FILE`) and validate them all;
 * 2. take the single-instance lock (03 §5.3), apply migrations, and refuse to start while live
 *    games would be orphaned, judged against `installed.json` only (no game code is loaded yet);
 * 3. scrub secrets from `process.env`;
 * 4. check code generation from strings is really off, then load the generated game registry with
 *    a dynamic `import()`, and refuse to start unless it matches `installed.json`;
 * 5. check the gmail token's scope and account (when that is the provider), then serve.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { serve } from "@hono/node-server";
import {
  createJsonLogger,
  installedSchema,
  isLocalDev,
  registryMismatches,
} from "@your-move/server";

import installedJson from "../../../generated/installed.json" with { type: "json" };
import { codeGenerationFromStringsAllowed } from "./code-generation.js";
import { scrubSecrets } from "./env.js";
import { createBackgroundTracker, createNodePlatform } from "./platform.js";
import { createNodeApp } from "./server.js";
import { isRefusal, startup, type Started, verifyEmail } from "./startup.js";

function exitWith(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values: args } = parseArgs({
  options: {
    static: { type: "string", default: fileURLToPath(new URL("public", import.meta.url)) },
    migrations: {
      type: "string",
      default: fileURLToPath(new URL("migrations", import.meta.url)),
    },
  },
});

const installed = installedSchema.parse(installedJson);

// 1–2. Configuration, then storage.
let started: Started;
try {
  started = await startup({
    env: process.env,
    readFile: (path) => readFileSync(path, "utf8"),
    installed,
    migrationsFolder: args.migrations,
  });
} catch (error) {
  if (isRefusal(error)) exitWith(error.message);
  throw error;
}
const { config, nodeConfig, storage } = started;

// 3. No secret survives in the environment once game code can run (02 §7.5).
scrubSecrets(process.env);
scrubSecrets(started.env);

const now = (): Date => new Date();
const log = createJsonLogger({
  level: config.logLevel,
  now,
  sink: (line) => process.stdout.write(`${line}\n`),
});

log.info("database ready", {
  migrationsApplied: storage.migrations.applied,
  migrationsKnown: storage.migrations.known,
});
if (storage.exposedDirectoryMode !== null) {
  // The files themselves are 0600 (08, M2a review S-3), but others can list or enter the
  // directory; an existing directory isn't changed behind the operator's back (S2-4).
  log.warn("the database directory is open to group or others: chmod 0700 it", {
    databaseDirectory: dirname(nodeConfig.databasePath),
    mode: storage.exposedDirectoryMode,
  });
}
if (storage.acceptedOrphans.length > 0) {
  // Until M3 nothing cancels them: they keep their state and must not be played (10 M3).
  log.warn("ALLOW_ORPHAN_GAMES: these live games are orphaned", {
    orphanedGames: storage.acceptedOrphans.map((orphan) => orphan.id).join(","),
  });
}

if (nodeConfig.trustProxy !== "false") {
  log.warn("client IPs come from a proxy header", { trustProxy: nodeConfig.trustProxy });
  if (nodeConfig.trustProxyPeersDefaulted) {
    log.warn("TRUST_PROXY_PEERS is not set; trusting the broad private-range default");
  }
}

// 4. Game code never runs in a process that can compile strings (02 §7.5).
if (codeGenerationFromStringsAllowed()) {
  exitWith("Refusing to start: run node with --disallow-code-generation-from-strings (02 §7.5).");
}

const { installedGames: games } = await import("../../../generated/server-registry.js");
const mismatches = registryMismatches(games, installed);
if (mismatches.length > 0) {
  exitWith(`The game registry does not match installed.json:\n  - ${mismatches.join("\n  - ")}`);
}

// 5. Serve. The gmail provider first checks its token's scope and account (09 §2): a token that
// could do more than send, or belongs to another user, refuses the start.
const platform = createNodePlatform({ repos: storage.repos, config, nodeConfig, log, now });
try {
  await verifyEmail(platform.email);
} catch (error) {
  if (isRefusal(error)) exitWith(`Refusing to start: ${error.message}`);
  throw error;
}
const app = createNodeApp({
  platform,
  games,
  staticRoot: args.static,
});
// Background work (emails) is per request and tracked, so shutdown waits for it (03 §4).
const background = createBackgroundTracker();
const server = serve(
  {
    fetch: (request, env) => app.fetch(request, env, background.context()),
    port: nodeConfig.port,
    // Local-dev mode serves /__dev/emails (sign-in codes): reachable from this machine only.
    ...(isLocalDev(config) ? { hostname: "127.0.0.1" } : {}),
  },
  (info) => {
    log.info("listening", { port: info.port, games: games.length });
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info("shutting down", { signal });
    server.close(() => {
      void background.drain().finally(() => {
        storage.close();
        process.exit(0);
      });
    });
  });
}
