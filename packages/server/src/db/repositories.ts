/**
 * Repository interfaces (docs/spec/03-architecture.md §4): what the core knows about storage. Each
 * method is a whole operation; the core never sees a Drizzle database object. Record types are
 * the rows of the shared schema (04), so the interfaces and the migrations can't drift apart.
 *
 * M2a provided users and games, enough for the `write_token` transition (03 §5.2) and the orphan
 * check (02 §7.3); M2b adds what sign-in needs: OTP challenges, sessions, rate limits, auth events
 * and API-token revocation; the alpha's framework core (A2) what one game needs: its resources and
 * invites, the game list, history, unread markers and past opponents; alpha A6 the email-nudge
 * setting, the seats due a nudge and the suppression list; alpha A8 the push subscriptions.
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import type { NormalisedEmail } from "../accounts/email.js";
import type {
  AUTH_EVENT_TYPES,
  emailSuppressions,
  GAME_STATUSES,
  gameActions,
  gamePlayers,
  gameResources,
  games,
  invites,
  otpChallenges,
  pushSubscriptions,
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

/** Turning email nudges on (with the address's `emailId`) or off (03 §7, 04 `users.email_id`). */
type EmailNudgesChange =
  | { readonly enabled: true; readonly emailId: string; readonly updatedAt: number }
  | { readonly enabled: false; readonly updatedAt: number };

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
  /** The users with these ids that exist, in no particular order. */
  findByIds(ids: readonly string[]): Promise<UserRecord[]>;
  findByEmail(email: NormalisedEmail): Promise<UserRecord | null>;
  /**
   * Which of `candidates` are past opponents of the user (04 `past_opponents`). Ids that match no
   * user simply aren't returned, so callers can pass a placeholder to keep the query the same.
   */
  pastOpponentsOf(userId: string, candidates: readonly string[]): Promise<string[]>;
  update(id: string, set: UserUpdate): Promise<void>;
  /**
   * Sets `settings.lastGameType` and, unless `input` is null, `settings.lastOptions[gameType]` to
   * the JSON `input`, leaving every other key as it is now in the database (05 §Remembered
   * options). `gameType` matches the manifest's type pattern.
   */
  rememberGameOptions(
    id: string,
    remember: { gameType: string; input: string | null; updatedAt: number },
  ): Promise<void>;
  /**
   * Sets `settings.emailNudges`, leaving every other key as it is now in the database.
   * `users.email_id` (04) is set exactly while nudges are on: turning them on records the
   * address's `emailId`, which a `nudges` unsubscribe token looks the account up by (05 §Email
   * links); turning them off clears it. Suppressions are left alone.
   */
  setEmailNudges(id: string, change: EmailNudgesChange): Promise<void>;
  /**
   * Turns email nudges off, and clears `email_id`, for the account whose `users.email_id` is
   * `emailId`, if there is one (a `nudges` unsubscribe, 05 §Email links). Repeating it changes
   * nothing more.
   */
  disableNudgesByEmailId(emailId: string, updatedAt: number): Promise<void>;
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

/** A session is live when both hold (06 §4); built by `liveSessionCutoffs`. */
export interface SessionCutoffs {
  /** `expires_at` (the sliding expiry) is after this. */
  readonly expiresAfter: number;
  /** `created_at` is after this (the absolute cap). */
  readonly createdAfter: number;
}

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

export type GameStatus = (typeof GAME_STATUSES)[number];
export type GameRecord = InferSelectModel<typeof games>;
export type GamePlayerRecord = InferSelectModel<typeof gamePlayers>;
export type GameActionRecord = InferSelectModel<typeof gameActions>;
export type GameResourceRecord = Omit<InferSelectModel<typeof gameResources>, "gameId">;
/** A logged transition without its secret columns (`action`, `rng`): what history may show. */
export type PublicActionRecord = Omit<GameActionRecord, "action" | "rng">;

/** A new game row; `version`, `write_token` and `action_count` start at their defaults. */
export type NewGame = Omit<
  InferInsertModel<typeof games>,
  "version" | "writeToken" | "actionCount"
>;
/** A new `game_players` row of a known game. */
export type NewGamePlayer = Omit<InferInsertModel<typeof gamePlayers>, "gameId">;
/** A new `game_actions` row of a known game. */
export type NewGameAction = Omit<InferInsertModel<typeof gameActions>, "gameId">;
/** A new `invites` row of a known game: the `emailId` of an address the creator typed. */
export type NewInvite = Omit<InferInsertModel<typeof invites>, "gameId">;

/** What a new game is created with besides its players (04 `game_resources`, `invites`). */
export interface NewGameExtras {
  readonly resources?: readonly GameResourceRecord[];
  readonly invites?: readonly NewInvite[];
}

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

/** One direction of a past-opponent pair (04 `past_opponents`). */
export interface PastOpponentPair {
  readonly userId: string;
  readonly otherId: string;
  readonly lastFinishedAt: number;
}

/**
 * Everything one transition writes (03 §5.2): the game row, plus dependent writes that take effect
 * only if this transition won the race.
 */
export interface GameWriteSet {
  readonly game: GameUpdate;
  readonly insertPlayers?: readonly NewGamePlayer[];
  readonly updatePlayers?: readonly { readonly id: string; readonly set: GamePlayerUpdate }[];
  readonly insertActions?: readonly NewGameAction[];
  /**
   * Past-opponent rows written by a transition that finishes a game, each direction given. A pair
   * with a block in either direction is never written (04 invariant 6), checked in the same
   * statement.
   */
  readonly pastOpponents?: readonly PastOpponentPair[];
}

/** `stale`: another transition changed the game since `expectedVersion`; nothing was written. */
export type TransitionResult = "ok" | "stale";

/** A `lobby` or `active` game, as the orphan check needs it (02 §7.3). */
export interface LiveGameRow {
  readonly id: string;
  readonly gameType: string;
  readonly gameVersion: number;
}

/** A game with all of its `game_players` rows, read together. */
export interface LoadedGame {
  readonly game: GameRecord;
  readonly players: readonly GamePlayerRecord[];
}

/** Which of a user's games to list (05 `GET /api/v1/games`). */
export interface GameListQuery {
  readonly userId: string;
  readonly status?: GameStatus;
  readonly gameType?: string;
  /**
   * `normal` or `hidden`: only the user's open invitations (in a `lobby`) with that delivery.
   * Otherwise every game the user is a member of, except hidden invitations.
   */
  readonly invitations?: "normal" | "hidden";
  /** `finished` games ended at or after this time are listed. */
  readonly finishedSince: number;
  /** `declined`, `cancelled` and `expired` games ended at or after this time are listed. */
  readonly endedSince: number;
  /** Continue after this game (newest activity first: `last_action_at`, then id, descending). */
  readonly after?: { readonly lastActionAt: number; readonly id: string };
  readonly limit: number;
}

/**
 * The `games` columns the game list shows (05 `GameSummary`): never the secret ones, and of the
 * state and the final views only what the viewer's summary line needs (A2 review P-16).
 */
export type ListedGame = Pick<
  GameRecord,
  | "id"
  | "gameType"
  | "gameVersion"
  | "status"
  | "endReason"
  | "aiAssistance"
  | "seats"
  | "turnTimeoutDays"
  | "startedAt"
  | "lastActionAt"
  | "version"
> & {
  /** The module state while `active`, for the module's `summary`; otherwise null. */
  readonly state: string | null;
  /** The viewer's own `final_views` summary (JSON) once a started game ended; otherwise null. */
  readonly finalSummary: string | null;
};

/** One listed game: its listed columns and the viewer's own `game_players` row. */
export interface GameListRow {
  readonly game: ListedGame;
  readonly member: GamePlayerRecord;
}

export interface GameRepo {
  /** Inserts a new game, its first `game_players` rows, resources and invites atomically. */
  create(game: NewGame, players: readonly NewGamePlayer[], extras?: NewGameExtras): Promise<void>;
  /** The game row, secret columns included (the core decides what leaves the server). */
  get(id: string): Promise<GameRecord | null>;
  /** The game row and its players, read in one batch. */
  load(id: string): Promise<LoadedGame | null>;
  /** The game's `game_players` rows, ordered by seat and then as they were added. */
  players(gameId: string): Promise<GamePlayerRecord[]>;
  /** The `game_players` rows of several games, ordered by game, seat and then as added. */
  playersOf(gameIds: readonly string[]): Promise<GamePlayerRecord[]>;
  /** The game's resources (04 `game_resources`). */
  resources(gameId: string): Promise<GameResourceRecord[]>;
  /** The game's action log in `seq` order, secret columns included (replay, 02 §5). */
  actions(gameId: string): Promise<GameActionRecord[]>;
  /** Up to `limit` logged transitions after `afterSeq`, oldest first, without secret columns. */
  history(gameId: string, afterSeq: number, limit: number): Promise<PublicActionRecord[]>;
  /** The newest logged transition of each game that has one, without secret columns. */
  lastActions(gameIds: readonly string[]): Promise<PublicActionRecord[]>;
  /** A user's games (05 `GET /api/v1/games`), newest activity first. */
  listForUser(query: GameListQuery): Promise<GameListRow[]>;
  /**
   * Raises the user's unread marker in a game to `version` (never lowers it, never past the game's
   * own version). Not a transition: it touches only the user's own row.
   */
  markSeen(gameId: string, userId: string, version: number): Promise<void>;
  /**
   * Up to `limit` ids of `lobby` games created at or before `createdBefore` in which the user
   * is a member (04 §Membership: not a declined, left or inert row), oldest first: the lobbies lazy expiry looks at (02 §4).
   */
  overdueLobbies(userId: string, createdBefore: number, limit: number): Promise<string[]>;
  /** How many `lobby`/`active` games the user created (05 `TOO_MANY_GAMES`). */
  countLiveCreated(userId: string): Promise<number>;
  /**
   * How many `lobby`/`active` games the user created with an address of this `emailId` among the
   * typed invitees (05 `TOO_MANY_GAMES`, per pair).
   */
  countLiveCreatedWithInvite(userId: string, emailHash: string): Promise<number>;
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

type SuppressionReason = InferSelectModel<typeof emailSuppressions>["reason"];

export interface EmailSuppressionRepo {
  /**
   * Adds an `emailId` to `email_suppressions` (04). An address already there keeps its row, except
   * that `bounced` or `complained` replaces `unsubscribed` (reason and `created_at`); repeating a
   * call changes nothing.
   */
  suppress(emailHash: string, reason: SuppressionReason, createdAt: number): Promise<void>;
}

/** A seat whose user may be sent an "It's your turn" email (03 §7). */
export interface DueNudge {
  /** The `game_players` row. */
  readonly playerId: string;
  readonly gameId: string;
  readonly gameType: string;
  readonly gameVersion: number;
  readonly seat: number;
  readonly userId: string;
  readonly email: NormalisedEmail;
  /** The user's `users.email_id`. */
  readonly emailId: string;
}

/** When a nudge is due (03 §7): both times are cut-offs, inclusive. */
export interface NudgeWindow {
  /** The seat has been in `toAct` since at or before this time. */
  readonly idleSince: number;
  /** The seat was last nudged at or before this time, or never. */
  readonly nudgedBefore: number;
}

/** A game type and one rules version of it that this build installs (02 §7.3). */
interface InstalledVersion {
  readonly gameType: string;
  readonly gameVersion: number;
}

export interface NudgeRepo {
  /**
   * Up to `limit` seats due a nudge (03 §7), longest waiting first: a `playing` seat in `toAct`
   * of an `active` game of one of the `installed` type and version pairs (so orphaned games never
   * take a place in the queue), idle and not nudged within the window, whose user is an onboarded
   * human, not suspended or being deleted, with `settings.emailNudges` true and an `email_id`
   * that hasn't bounced or complained (an `unsubscribed` row is about invite emails; nudges have
   * their own opt-out, 03 §7). At most one seat per recipient (their least recently nudged,
   * then longest waiting); recipients nudged least recently in any game come first.
   */
  due(
    window: NudgeWindow,
    limit: number,
    installed: readonly InstalledVersion[],
  ): Promise<DueNudge[]>;
  /**
   * Claims one seat's nudge: sets `last_nudged_at` to `now` only if everything `due` checks
   * still holds for it (the seat, its game and its user), so a move, an unsubscribe or a
   * suspension in between stops it. True only for the one call that changed the row. Not a game
   * transition: the game's `version` is untouched (03 §7).
   */
  claim(playerId: string, now: number, window: NudgeWindow): Promise<boolean>;
}

/** A stored Web Push subscription (04 `push_subscriptions`). */
type PushSubscriptionRecord = InferSelectModel<typeof pushSubscriptions>;
/** A subscription to save; `last_success_at` starts unset. */
export type NewPushSubscription = Omit<PushSubscriptionRecord, "lastSuccessAt">;

export interface PushSubscriptionRepo {
  /**
   * Saves a subscription bound to its session (05 §Push subscriptions), then keeps only the user's
   * `maxPerUser` most useful (04): rows of live sessions before the rest, then by last success,
   * else creation; the others are evicted, in one atomic batch. An endpoint already stored for
   * the same user and session is updated in place (an idempotent upsert, keeping its id). One
   * stored for another user or session moves to this user and session only if the keys sent
   * equal the stored ones (the same browser subscription) or its session is no longer live;
   * otherwise nothing changes. A move keeps the id; `created_at` and `last_success_at` are kept
   * when the user is the same and start afresh when the endpoint changes hands. The saved
   * subscription is never the one evicted.
   */
  save(
    subscription: NewPushSubscription,
    rules: { readonly maxPerUser: number; readonly live: SessionCutoffs },
  ): Promise<void>;
  /** Deletes the user's subscription with this endpoint, if it is theirs. */
  remove(userId: string, endpoint: string): Promise<void>;
  /** Every subscription of these users whose session is live (A8-S-2). */
  forUsers(userIds: readonly string[], live: SessionCutoffs): Promise<PushSubscriptionRecord[]>;
  /** Deletes subscriptions whose push service answered 404 or 410 (04), in one statement. */
  delete(ids: readonly string[]): Promise<void>;
  /** Records deliveries the push services accepted, in one statement. */
  delivered(ids: readonly string[], at: number): Promise<void>;
}

/** All repositories a runtime provides through `Platform.repos`. */
export interface Repositories {
  readonly users: UserRepo;
  readonly games: GameRepo;
  readonly nudges: NudgeRepo;
  readonly emailSuppressions: EmailSuppressionRepo;
  readonly pushSubscriptions: PushSubscriptionRepo;
  readonly otp: OtpRepo;
  readonly sessions: SessionRepo;
  readonly rateLimits: RateLimitRepo;
  readonly authEvents: AuthEventRepo;
  readonly apiTokens: ApiTokenRepo;
}
