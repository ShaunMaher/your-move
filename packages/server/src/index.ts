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
export { normaliseAddress, type NormalisedEmail } from "./accounts/email.js";
export {
  resolveClientIp,
  type ClientIp,
  type ClientIpSource,
  type TrustProxy,
} from "./auth/client-ip.js";
export {
  createConsoleEmailSender,
  type CapturedEmail,
  type EmailMessage,
  type EmailSender,
} from "./email/sender.js";
export { coreEmailSender } from "./email/providers.js";
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
  ApiTokenRepo,
  AuthEventRepo,
  AuthEventType,
  NewAuthEvent,
  NewOtpChallenge,
  NewSession,
  OtpAttempt,
  OtpPurpose,
  OtpRepo,
  RateLimitCount,
  RateLimitHit,
  RateLimitRepo,
  SessionRecord,
  SessionRepo,
  UserUpdate,
} from "./db/repositories.js";
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
export { GameConfigError } from "./games/registry.js";
export {
  type BuiltinDictionaries,
  NO_DICTIONARIES,
  ResourceConfigError,
} from "./games/resources.js";
export { parseIndex, servedFileName, type DictionaryManifest } from "@your-move/dictionary";
export { createJsonLogger, type LogFields, type Logger } from "./log.js";
