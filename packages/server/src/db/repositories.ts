/**
 * Repository interfaces (docs/spec/03-architecture.md §4): what the core knows about storage. Each
 * method is a whole operation; the core never sees a Drizzle database object. Record types are
 * the rows of the shared schema (04), so the interfaces and the migrations can't drift apart.
 *
 * M2a provides users and games, enough for the `write_token` transition (03 §5.2) and the orphan
 * check (02 §7.3). Sessions, OTP challenges and rate limits join with M2b; their tables already
 * exist (one migration set, 04).
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import type { gameActions, gamePlayers, games, users } from "./schema.js";

export type UserRecord = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export interface UserRepo {
  /** Inserts a user; a duplicate id or email is a constraint error. */
  create(user: NewUser): Promise<void>;
  findById(id: string): Promise<UserRecord | null>;
  /** `email` must already be normalised (04 conventions). */
  findByEmail(email: string): Promise<UserRecord | null>;
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
}
