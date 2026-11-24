/**
 * The Node entry point (docs/spec/09-operations.md §4). Run with
 * `node --disallow-code-generation-from-strings`. Startup order (02 §7.3, §7.5):
 *
 * 1. open the database, apply migrations, and refuse to start while live games would be
 *    orphaned, judged against `installed.json` only (no game code is loaded yet);
 * 2. read configuration and secrets (`*_FILE`), then scrub secrets from `process.env`;
 * 3. check code generation from strings is really off, then load the generated game registry with
 *    a dynamic `import()`, and refuse to start unless it matches `installed.json`;
 * 4. serve.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { serve } from "@hono/node-server";
import {
  ConfigError,
  createJsonLogger,
  installedSchema,
  parseConfig,
  registryMismatches,
} from "@your-move/server";

import installedJson from "../../../generated/installed.json" with { type: "json" };
import { codeGenerationFromStringsAllowed } from "./code-generation.js";
import { MigrationError } from "./db/migrate.js";
import { resolveSecretFiles, scrubSecrets, SecretFileError } from "./env.js";
import { parseNodeConfig } from "./node-config.js";
import { createNodeApp } from "./server.js";
import { openStorage, StartupRefusal, type Storage } from "./storage.js";

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
const installedGames = Object.entries(installed).map(([type, entry]) => ({
  type,
  enabledByDefault: entry.enabledByDefault,
}));

// 1. Storage. The Node-only variables hold no secrets, so they are read before the secret files.
let nodeConfig: ReturnType<typeof parseNodeConfig>;
let storage: Storage;
try {
  nodeConfig = parseNodeConfig(process.env);
  storage = await openStorage({
    databasePath: nodeConfig.databasePath,
    migrationsFolder: args.migrations,
    installed,
    allowOrphanGames: nodeConfig.allowOrphanGames,
  });
} catch (error) {
  if (
    error instanceof ConfigError ||
    error instanceof StartupRefusal ||
    error instanceof MigrationError
  ) {
    exitWith(error.message);
  }
  throw error;
}

// 2. Configuration and secrets.
let env: Record<string, string | undefined>;
let config: ReturnType<typeof parseConfig>;
try {
  env = resolveSecretFiles(process.env, (path) => readFileSync(path, "utf8"));
  config = parseConfig(env, { runtime: "node", installedGames });
} catch (error) {
  if (error instanceof ConfigError || error instanceof SecretFileError) exitWith(error.message);
  throw error;
}
scrubSecrets(process.env);
scrubSecrets(env);

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
if (storage.acceptedOrphans.length > 0) {
  log.warn("ALLOW_ORPHAN_GAMES: live games are orphaned and will be cancelled by the sweep", {
    orphanedGames: storage.acceptedOrphans.length,
  });
}

if (nodeConfig.trustProxy !== "false") {
  log.warn("client IPs come from a proxy header", { trustProxy: nodeConfig.trustProxy });
  if (nodeConfig.trustProxyPeersDefaulted) {
    log.warn("TRUST_PROXY_PEERS is not set; trusting the broad private-range default");
  }
}

// 3. Game code never runs in a process that can compile strings (02 §7.5).
if (codeGenerationFromStringsAllowed()) {
  exitWith("Refusing to start: run node with --disallow-code-generation-from-strings (02 §7.5).");
}

const { installedGames: games } = await import("../../../generated/server-registry.js");
const mismatches = registryMismatches(games, installed);
if (mismatches.length > 0) {
  exitWith(`The game registry does not match installed.json:\n  - ${mismatches.join("\n  - ")}`);
}

// 4. Serve.
const app = createNodeApp({
  platform: { repos: storage.repos, config, log, now },
  games,
  staticRoot: args.static,
});
const server = serve({ fetch: app.fetch, port: nodeConfig.port }, (info) => {
  log.info("listening", { port: info.port, games: games.length });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info("shutting down", { signal });
    server.close(() => {
      storage.sqlite.close();
      process.exit(0);
    });
  });
}
