/**
 * Repository interfaces (docs/spec/03-architecture.md §4): what the core knows about storage. Each
 * method is a whole operation; the core never sees a Drizzle database object. Record types are
 * the rows of the shared schema (04), so the interfaces and the migrations can't drift apart.
 *
 * M2a provided users and games, enough for the `write_token` transition (03 §5.2) and the orphan
 * check (02 §7.3); M2b adds what sign-in needs: OTP challenges, sessions, rate limits, auth events
 * and API-token revocation.
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import type { NormalisedEmail } from "../accounts/email.js";
import type {
  AUTH_EVENT_TYPES,
  gameActions,
  gamePlayers,
  games,
  otpChallenges,
  sessions,
  users,
} from "./schema.js";

/** A user row; a stored address is always normalised (04), so it carries the brand. */
export type UserRecord = Omit<InferSelectModel<typeof users>, "email"> & {
  email: NormalisedEmail | null;
};
/** A new human or agent; a human's `email` is a {@link NormalisedEmail} (M2a review S2-3). */
export type NewUser = Omit<InferInsertModel<typeof users>, "email"> & {
  email?: NormalisedEmail | null;
};

/** The `users` columns the account endpoints change. `updated_at` is always set. */
export type UserUpdate = Partial<Pick<UserRecord, "displayName" | "onboardedAt">> &
  Pick<UserRecord, "updatedAt">;

export interface UserRepo {
  /** Inserts a user; a duplicate id or email is a constraint error. */
  create(user: NewUser): Promise<void>;
  /**
   * Inserts a human with this address unless one already exists, then returns whichever user holds
   * the address, so two sign-ins racing to create the same account both end up with the same row.
   */
  createOrGetByEmail(user: NewUser & { email: NormalisedEmail }): Promise<UserRecord>;
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: NormalisedEmail): Promise<UserRecord | null>;
  update(id: string, set: UserUpdate): Promise<void>;
  /**
   * Deletes an account that holds no game rows (04 §Account deletion steps 1, 3, 4 and 5): its
   * sessions and API tokens, its OTP challenges, blocks and past-opponent rows, the
   * `account_deleted` event (written while the row still exists), then the user row, whose
   * foreign keys null the remaining references. One atomic batch, so it is safe to repeat.
   */
  deleteAccount(user: { id: string; email: NormalisedEmail }, event: NewAuthEvent): Promise<void>;
}

export type OtpPurpose = InferSelectModel<typeof otpChallenges>["purpose"];
export type NewOtpChallenge = Omit<
  InferInsertModel<typeof otpChallenges>,
  "attempts" | "consumedAt" | "email"
> & { email: NormalisedEmail };

/** What a counted attempt returns: the stored hash, and whether the code was ever emailed. */
export interface OtpAttempt {
  readonly codeHash: string;
  readonly emailed: boolean;
}

export interface OtpRepo {
  /**
   * Issues a challenge in one atomic batch (06 §3): inserts it, then burns (consumes) every live
   * challenge of the same email and purpose beyond the newest `maxLive`. With `create` false the
   * same statements run but match nothing, so a silently dropped request does the same database
   * work as any other (06 §3.2) while creating and touching nothing.
   */
  issue(
    challenge: NewOtpChallenge,
    options: { readonly create: boolean; readonly maxLive: number; readonly maxAttempts: number },
  ): Promise<void>;
  /** Ids of the live challenges (unconsumed, unexpired, attempts left), newest first. */
  live(
    email: NormalisedEmail,
    purpose: OtpPurpose,
    now: number,
    maxAttempts: number,
  ): Promise<string[]>;
  /**
   * Counts one attempt atomically (06 §3.1): only if the challenge is still live. `null` means it
   * wasn't, and the attempt must be treated as invalid.
   */
  attempt(id: string, now: number, maxAttempts: number): Promise<OtpAttempt | null>;
  /** Consumes a matched challenge; true only for the one request that changed the row. */
  consume(id: string, now: number): Promise<boolean>;
}

export type SessionRecord = InferSelectModel<typeof sessions>;
export type NewSession = InferInsertModel<typeof sessions>;

export interface SessionRepo {
  create(session: NewSession): Promise<void>;
  /** The session with this token hash and its user, or null. Expiry is the caller's to judge. */
  findByTokenHash(tokenHash: string): Promise<{ session: SessionRecord; user: UserRecord } | null>;
  /** Refreshes `last_seen_at` and the sliding expiry. */
  touch(id: string, lastSeenAt: number, expiresAt: number): Promise<void>;
  /** Deletes one session, scoped by its user (08 T11). */
  delete(userId: string, id: string): Promise<void>;
  /** Deletes every session of the user. */
  deleteAll(userId: string): Promise<void>;
}

/** One counter of a sliding-window limit (06 §3.1): the current and previous fixed windows. */
export interface RateLimitHit {
  readonly key: string;
  readonly windowStart: number;
  readonly previousWindowStart: number;
  /**
   * Added to the current window; 0 reads the counter through the same statements. Adding 0 writes
   * nothing, though (SQLite leaves an unchanged row's page alone), so it is quicker: use 0 only
   * where the amount doesn't depend on the account (06 §3.2).
   */
  readonly amount: number;
}

export interface RateLimitCount {
  readonly current: number;
  readonly previous: number;
}

export interface RateLimitRepo {
  /**
   * Adds each hit's amount to its current window (`INSERT … ON CONFLICT DO UPDATE … RETURNING`)
   * and reads its previous window, all in one atomic batch. Results follow the hits' order.
   */
  hit(hits: readonly RateLimitHit[]): Promise<RateLimitCount[]>;
}

export type AuthEventType = (typeof AUTH_EVENT_TYPES)[number];
export interface NewAuthEvent {
  readonly userId: string | null;
  readonly type: AuthEventType;
  readonly ipHash: string | null;
  readonly createdAt: number;
}

export interface AuthEventRepo {
  record(event: NewAuthEvent): Promise<void>;
}

export interface ApiTokenRepo {
  /** Revokes every live API token acting as the user or one of their AI accounts (06 §4). */
  revokeAll(userId: string, now: number): Promise<void>;
}

export type GameRecord = InferSelectModel<typeof games>;
export type GamePlayerRecord = InferSelectModel<typeof gamePlayers>;
export type GameActionRecord = InferSelectModel<typeof gameActions>;

/** A new game row; `version`, `write_token` and `action_count` start at their defaults. */
export type NewGame = Omit<
  InferInsertModel<typeof games>,
  "version" | "writeToken" | "actionCount"
>;
/** A new `game_players` row of a known game. */
export type NewGamePlayer = Omit<InferInsertModel<typeof gamePlayers>, "gameId">;
/** A new `game_actions` row of a known game. */
export type NewGameAction = Omit<InferInsertModel<typeof gameActions>, "gameId">;

/**
 * The `games` columns a transition may set. `version` and `write_token` are the repository's own
 * (03 §5.2); `updated_at` is always set.
 */
export type GameUpdate = Partial<
  Pick<
    GameRecord,
    | "status"
    | "state"
    | "setupRng"
    | "finalViews"
    | "seats"
    | "actionCount"
    | "lastActionAt"
    | "endReason"
    | "startedAt"
    | "endedAt"
  >
> &
  Pick<GameRecord, "updatedAt">;

/** The `game_players` columns a transition may set on an existing row. */
export type GamePlayerUpdate = Partial<Omit<GamePlayerRecord, "id" | "gameId">>;

/**
 * Everything one transition writes (03 §5.2): the game row, plus dependent writes that take effect
 * only if this transition won the race.
 */
export interface GameWriteSet {
  readonly game: GameUpdate;
  readonly insertPlayers?: readonly NewGamePlayer[];
  readonly updatePlayers?: readonly { readonly id: string; readonly set: GamePlayerUpdate }[];
  readonly insertActions?: readonly NewGameAction[];
}

/** `stale`: another transition changed the game since `expectedVersion`; nothing was written. */
export type TransitionResult = "ok" | "stale";

/** A `lobby` or `active` game, as the orphan check needs it (02 §7.3). */
export interface LiveGameRow {
  readonly id: string;
  readonly gameType: string;
  readonly gameVersion: number;
}

export interface GameRepo {
  /** Inserts a new game and its first `game_players` rows atomically. */
  create(game: NewGame, players: readonly NewGamePlayer[]): Promise<void>;
  /** The game row, secret columns included (the core decides what leaves the server). */
  get(id: string): Promise<GameRecord | null>;
  /** The game's `game_players` rows, ordered by seat and then id. */
  players(gameId: string): Promise<GamePlayerRecord[]>;
  /** The game's action log in `seq` order, secret columns included (replay, 02 §5). */
  actions(gameId: string): Promise<GameActionRecord[]>;
  /**
   * Applies one transition atomically (03 §5.2): bumps `version` and sets a fresh `write_token`
   * only if the game is still at `expectedVersion`, and applies every dependent write only if
   * that token is the one stored. Exactly one of several concurrent transitions from the same
   * version returns `ok`.
   */
  applyTransition(
    gameId: string,
    expectedVersion: number,
    writes: GameWriteSet,
  ): Promise<TransitionResult>;
  /** Every `lobby` or `active` game, for the orphan check. */
  liveGames(): Promise<LiveGameRow[]>;
}

/** All repositories a runtime provides through `Platform.repos`. */
export interface Repositories {
  readonly users: UserRepo;
  readonly games: GameRepo;
  readonly otp: OtpRepo;
  readonly sessions: SessionRepo;
  readonly rateLimits: RateLimitRepo;
  readonly authEvents: AuthEventRepo;
  readonly apiTokens: ApiTokenRepo;
}
