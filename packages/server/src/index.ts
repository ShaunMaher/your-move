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
  deriveSubkeys,
  emailId,
  hmacHex,
  SUBKEY_LABELS,
  verifyHmacHex,
  type SubkeyName,
  type Subkeys,
} from "./crypto/subkeys.js";
export type { Database } from "./db/database.js";
export { DetachedStorageError, detachedRepositories } from "./db/detached.js";
export { createRepositories } from "./db/repos.js";
export type {
  GameActionRecord,
  GamePlayerRecord,
  GamePlayerUpdate,
  GameRecord,
  GameRepo,
  GameUpdate,
  GameWriteSet,
  LiveGameRow,
  NewGame,
  NewGameAction,
  NewGamePlayer,
  NewUser,
  Repositories,
  TransitionResult,
  UserRecord,
  UserRepo,
} from "./db/repositories.js";
export {
  findLiveOrphans,
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
