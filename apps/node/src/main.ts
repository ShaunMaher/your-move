/**
 * The Node entry point (docs/spec/09-operations.md §4). Run with
 * `node --disallow-code-generation-from-strings`. Startup order (02 §7.3, §7.5):
 *
 * 1. migrations and the orphan check against `installed.json` — from M2, when there is a database;
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
import { resolveSecretFiles, scrubSecrets, SecretFileError } from "./env.js";
import { parseNodeConfig } from "./node-config.js";
import { createNodeApp } from "./server.js";

function exitWith(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values: args } = parseArgs({
  options: {
    static: { type: "string", default: fileURLToPath(new URL("public", import.meta.url)) },
  },
});

const installed = installedSchema.parse(installedJson);
const installedGames = Object.entries(installed).map(([type, entry]) => ({
  type,
  enabledByDefault: entry.enabledByDefault,
}));

let env: Record<string, string | undefined>;
let config: ReturnType<typeof parseConfig>;
let nodeConfig: ReturnType<typeof parseNodeConfig>;
try {
  env = resolveSecretFiles(process.env, (path) => readFileSync(path, "utf8"));
  config = parseConfig(env, { runtime: "node", installedGames });
  nodeConfig = parseNodeConfig(env);
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

if (nodeConfig.trustProxy !== "false") {
  log.warn("client IPs come from a proxy header", { trustProxy: nodeConfig.trustProxy });
  if (nodeConfig.trustProxyPeersDefaulted) {
    log.warn("TRUST_PROXY_PEERS is not set; trusting the broad private-range default");
  }
}

// Game code never runs in a process that can compile strings (02 §7.5).
if (codeGenerationFromStringsAllowed()) {
  exitWith("Refusing to start: run node with --disallow-code-generation-from-strings (02 §7.5).");
}

const { installedGames: games } = await import("../../../generated/server-registry.js");
const mismatches = registryMismatches(games, installed);
if (mismatches.length > 0) {
  exitWith(`The game registry does not match installed.json:\n  - ${mismatches.join("\n  - ")}`);
}

const app = createNodeApp({ platform: { config, log, now }, games, staticRoot: args.static });
const server = serve({ fetch: app.fetch, port: nodeConfig.port }, (info) => {
  log.info("listening", { port: info.port, games: games.length });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info("shutting down", { signal });
    server.close(() => process.exit(0));
  });
}
