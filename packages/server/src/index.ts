/**
 * The runtime-agnostic server core (docs/spec/03-architecture.md). Web-standard APIs only; each
 * runtime (`apps/node`, `apps/worker`) builds a {@link Platform} and calls {@link createApp}.
 */
export {
  createApp,
  type App,
  type AppEnv,
  openApiDocument,
  SERVER_PATHS,
  type AppOptions,
  type InstalledGame,
  type OpenApiDocument,
  type Platform,
} from "./app.js";
export { DEFAULT_APP_NAME } from "./config/defaults.js";
export { isLocalDev, isLocalDevUrl } from "./config/local-dev.js";
export {
  ConfigError,
  parseConfig,
  redactSecrets,
  SECRET_VARIABLES,
  type AppConfig,
  type EmailConfig,
  type Env,
  type InstalledGameType,
  type LogLevel,
  type Runtime,
} from "./config/parse.js";
export {
  HASHED_ASSETS_PREFIX,
  renderHeadersFile,
  securityHeaders,
  staticCacheControl,
  type SecurityHeaderOptions,
} from "./http/security-headers.js";
export {
  findOrphans,
  installedSchema,
  LIVE_GAMES_QUERY,
  liveGameSchema,
  registryMismatches,
  type Installed,
  type LiveGame,
  type Orphan,
} from "./games/installed.js";
export { createJsonLogger, type LogFields, type Logger } from "./log.js";
