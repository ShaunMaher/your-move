/**
 * Node startup up to the game registry import (docs/spec/02-game-framework.md §7.3, 09 §4, M2a
 * review S-6), in this order:
 *
 * 1. resolve the secret files (`*_FILE`) and validate the whole configuration, so a bad
 *    configuration refuses to start before anything touches the database;
 * 2. take the single-instance lock, apply migrations and run the orphan check against
 *    `installed.json` only (no game code is loaded yet).
 *
 * Once the platform exists, {@link verifyEmail} checks the email provider's credentials (the
 * `gmail` token's scope and account, 09 §2) before the server listens.
 *
 * The caller then scrubs the secrets from the environment, imports the registry and serves; the
 * scrub always comes before the import (02 §7.5).
 */
import {
  ConfigError,
  type CoreEmailSender,
  type Env,
  GmailTokenRefused,
  type Installed,
  isLocalDev,
  parseConfig,
  type AppConfig,
} from "@your-move/server";

import { InstanceLockedError } from "./db/instance-lock.js";
import { MigrationError } from "./db/migrate.js";
import { type ReadFile, resolveSecretFiles, SecretFileError } from "./env.js";
import { type NodeConfig, parseNodeConfig } from "./node-config.js";
import { openStorage, StartupRefusal, type Storage } from "./storage.js";

export interface StartupOptions {
  /** The process environment, secrets still in it. */
  readonly env: Env;
  readonly readFile: ReadFile;
  readonly installed: Installed;
  readonly migrationsFolder: string;
}

export interface Started {
  /** The environment with secret files resolved; the caller scrubs it. */
  readonly env: Record<string, string | undefined>;
  readonly config: AppConfig;
  readonly nodeConfig: NodeConfig;
  readonly storage: Storage;
}

/** Errors that refuse the start with a message safe to print as is (it names no secret). */
export function isRefusal(error: unknown): error is Error {
  return (
    error instanceof ConfigError ||
    error instanceof SecretFileError ||
    error instanceof StartupRefusal ||
    error instanceof InstanceLockedError ||
    error instanceof MigrationError
  );
}

/** Refuses to start when the email provider's credentials are wrong; a Google outage doesn't. */
export async function verifyEmail(email: CoreEmailSender): Promise<void> {
  try {
    await email.verifyCredentials?.();
  } catch (error) {
    if (error instanceof GmailTokenRefused) throw new StartupRefusal(`${error.message} (09 §2)`);
    throw error;
  }
}

/** Steps 1 and 2 above; throws to refuse the start. */
export async function startup(options: StartupOptions): Promise<Started> {
  const env = resolveSecretFiles(options.env, options.readFile);
  const config = parseConfig(env, {
    runtime: "node",
    installedGames: Object.entries(options.installed).map(([type, entry]) => ({
      type,
      enabledByDefault: entry.enabledByDefault,
    })),
  });
  const nodeConfig = parseNodeConfig(env, { localDev: isLocalDev(config) });
  const storage = await openStorage({
    databasePath: nodeConfig.databasePath,
    migrationsFolder: options.migrationsFolder,
    installed: options.installed,
    allowOrphanGames: nodeConfig.allowOrphanGames,
  });
  return { env, config, nodeConfig, storage };
}
