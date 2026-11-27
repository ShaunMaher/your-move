/**
 * Repositories with no database behind them, for an app that never touches storage: the OpenAPI
 * document generator (`pnpm api:generate`) and tests of HTTP behaviour alone. Every call rejects,
 * so accidental use fails loudly instead of pretending to succeed.
 */
import type {
  ApiTokenRepo,
  AuthEventRepo,
  EmailSuppressionRepo,
  GameRepo,
  NudgeRepo,
  OtpRepo,
  PushSubscriptionRepo,
  RateLimitRepo,
  Repositories,
  SessionRepo,
  UserRepo,
} from "./repositories.js";

export class DetachedStorageError extends Error {
  override readonly name = "DetachedStorageError";

  constructor(operation: string) {
    super(`${operation}: this app has no database`);
  }
}

/**
 * Every method of each repository. `satisfies` makes the compiler demand an entry for each one,
 * so a method added to an interface can't be left undefined here.
 */
const METHODS = {
  users: {
    create: true,
    createOrGetByEmail: true,
    findById: true,
    findByIds: true,
    findByEmail: true,
    pastOpponentsOf: true,
    pickableOpponents: true,
    recentOpponents: true,
    blocksAmong: true,
    update: true,
    rememberGameOptions: true,
    setEmailNudges: true,
    setTheme: true,
    disableNudgesByEmailId: true,
    deleteAccount: true,
  } satisfies Record<keyof UserRepo, true>,
  otp: { issue: true, live: true, attempt: true, consume: true } satisfies Record<
    keyof OtpRepo,
    true
  >,
  sessions: {
    create: true,
    findByTokenHash: true,
    touch: true,
    delete: true,
    deleteAll: true,
  } satisfies Record<keyof SessionRepo, true>,
  rateLimits: { hit: true } satisfies Record<keyof RateLimitRepo, true>,
  authEvents: { record: true } satisfies Record<keyof AuthEventRepo, true>,
  apiTokens: { revokeAll: true } satisfies Record<keyof ApiTokenRepo, true>,
  nudges: { due: true, claim: true } satisfies Record<keyof NudgeRepo, true>,
  emailSuppressions: { suppress: true } satisfies Record<keyof EmailSuppressionRepo, true>,
  pushSubscriptions: {
    save: true,
    remove: true,
    forUsers: true,
    delete: true,
    delivered: true,
  } satisfies Record<keyof PushSubscriptionRepo, true>,
  games: {
    create: true,
    createRematch: true,
    rematchRead: true,
    get: true,
    load: true,
    players: true,
    playersOf: true,
    resources: true,
    actions: true,
    history: true,
    lastActions: true,
    listForUser: true,
    markSeen: true,
    overdueLobbies: true,
    countLiveCreated: true,
    countLiveCreatedWithInvite: true,
    countLiveCreatedWithUser: true,
    applyTransition: true,
    liveGames: true,
  } satisfies Record<keyof GameRepo, true>,
} as const satisfies Record<keyof Repositories, object>;

function detached<K extends string>(
  name: string,
  methods: Record<K, true>,
): Record<K, () => Promise<never>> {
  return Object.fromEntries(
    Object.keys(methods).map((method) => [
      method,
      () => Promise.reject(new DetachedStorageError(`${name}.${method}`)),
    ]),
  ) as Record<K, () => Promise<never>>;
}

export function detachedRepositories(): Repositories {
  return {
    users: detached("users", METHODS.users),
    games: detached("games", METHODS.games),
    nudges: detached("nudges", METHODS.nudges),
    emailSuppressions: detached("emailSuppressions", METHODS.emailSuppressions),
    pushSubscriptions: detached("pushSubscriptions", METHODS.pushSubscriptions),
    otp: detached("otp", METHODS.otp),
    sessions: detached("sessions", METHODS.sessions),
    rateLimits: detached("rateLimits", METHODS.rateLimits),
    authEvents: detached("authEvents", METHODS.authEvents),
    apiTokens: detached("apiTokens", METHODS.apiTokens),
  };
}
