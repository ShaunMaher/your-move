/**
 * The one shared database schema (docs/spec/04-data-model.md), SQLite dialect for both D1 and the
 * Node driver. `drizzle-kit generate` turns it into the SQL migrations in
 * `packages/server/migrations/`, which are reviewed and committed (11 §3).
 *
 * Conventions (04): ids are TEXT UUIDs, timestamps INTEGER milliseconds since the epoch (UTC), JSON
 * columns TEXT parsed by Zod on read, emails stored normalised. Columns marked SECRET are secret
 * game state and never reach a client (04 invariant 4).
 *
 * Only the core's repository implementations (`src/db/`) import this module; everything else uses
 * the repository interfaces (03 §4).
 */
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** `created_at` and `updated_at`, both required. */
const timestamps = {
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
};

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["human", "agent"] })
      .notNull()
      .default("human"),
    ownerUserId: text("owner_user_id").references((): AnySQLiteColumn => users.id, {
      onDelete: "cascade",
    }),
    email: text("email").unique(),
    /**
     * The address's `emailId` (09 §1.1), set when email nudges are turned on, so a `nudges`
     * unsubscribe token can find the account (05 §Email links).
     */
    emailId: text("email_id").unique(),
    displayName: text("display_name"),
    settings: text("settings").notNull().default("{}"),
    ageAttestedAt: integer("age_attested_at"),
    ageAttestedMinAge: integer("age_attested_min_age"),
    onboardedAt: integer("onboarded_at"),
    deletionRequestedAt: integer("deletion_requested_at"),
    suspendedAt: integer("suspended_at"),
    ...timestamps,
  },
  (table) => [index("users_owner_user_id").on(table.ownerUserId)],
);

export const otpChallenges = sqliteTable(
  "otp_challenges",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    purpose: text("purpose", {
      enum: ["signin", "delete_account", "token_create", "token_admin"],
    }).notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
    emailed: integer("emailed").notNull().default(1),
  },
  (table) => [index("otp_challenges_email").on(table.email, table.purpose)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    userAgent: text("user_agent"),
  },
  (table) => [index("sessions_user_id").on(table.userId)],
);

export const GAME_STATUSES = [
  "lobby",
  "active",
  "finished",
  "declined",
  "cancelled",
  "expired",
] as const;

export const games = sqliteTable(
  "games",
  {
    id: text("id").primaryKey(),
    gameType: text("game_type").notNull(),
    gameVersion: integer("game_version").notNull(),
    /** Resolved options, JSON (public). */
    options: text("options").notNull(),
    status: text("status", { enum: GAME_STATUSES }).notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    seats: integer("seats").notNull(),
    turnTimeoutDays: integer("turn_timeout_days").notNull(),
    seatOrder: text("seat_order", { enum: ["join", "random"] }).notNull(),
    aiAssistance: text("ai_assistance", { enum: ["off", "allowed"] }).notNull(),
    /** SECRET: module state JSON; NULL in the lobby. */
    state: text("state"),
    /** SECRET: random draws consumed at start. */
    setupRng: text("setup_rng"),
    /** JSON `{ seats: { view, summary }[], public: { view, summary } }`; one seat per player. */
    finalViews: text("final_views"),
    version: integer("version").notNull().default(0),
    writeToken: text("write_token"),
    actionCount: integer("action_count").notNull().default(0),
    lastActionAt: integer("last_action_at").notNull(),
    endReason: text("end_reason"),
    ...timestamps,
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
  },
  (table) => [
    index("games_status").on(table.status, table.gameType),
    index("games_created_by").on(table.createdBy),
  ],
);

export const PLAYER_STATES = [
  "invited",
  "joined",
  "declined",
  "left",
  "removed",
  "playing",
  "out",
  "dropped",
] as const;

export const gamePlayers = sqliteTable(
  "game_players",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    seat: integer("seat"),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    inviteEmail: text("invite_email"),
    state: text("state", { enum: PLAYER_STATES }).notNull(),
    outReason: text("out_reason", {
      enum: ["eliminated", "resigned", "timed_out", "declined", "cancelled"],
    }),
    joinedVia: text("joined_via", {
      enum: ["creator", "added", "invitation", "email_invite", "join_link"],
    }),
    delivery: text("delivery", { enum: ["normal", "hidden", "inert"] })
      .notNull()
      .default("normal"),
    removedAt: integer("removed_at"),
    joinedAt: integer("joined_at"),
    toAct: integer("to_act").notNull().default(0),
    toActSince: integer("to_act_since"),
    actedOnce: integer("acted_once").notNull().default(0),
    rank: integer("rank"),
    score: integer("score"),
    lastSeenVersion: integer("last_seen_version").notNull().default(0),
    lastNudgedAt: integer("last_nudged_at"),
    timeoutRemindersSent: integer("timeout_reminders_sent").notNull().default(0),
  },
  (table) => [
    // 04: unique where not null. SQLite treats NULLs as distinct in a unique index, so plain
    // indexes mean exactly that, and they also serve every lookup by game_id.
    uniqueIndex("game_players_game_user").on(table.gameId, table.userId),
    uniqueIndex("game_players_game_seat").on(table.gameId, table.seat),
    index("game_players_user_to_act").on(table.userId, table.toAct),
    index("game_players_user_state").on(table.userId, table.state),
    index("game_players_invite_email").on(table.inviteEmail),
  ],
);

export const gameActions = sqliteTable(
  "game_actions",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    seat: integer("seat").notNull(),
    kind: text("kind", { enum: ["action", "resign", "timeout", "decline"] }).notNull(),
    /** SECRET: the module action as submitted. */
    action: text("action"),
    record: text("record").notNull(),
    describe: text("describe").notNull(),
    /** SECRET: random draws consumed. */
    rng: text("rng"),
    via: text("via", { enum: ["app", "token", "system"] })
      .notNull()
      .default("app"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.gameId, table.seq] })],
);

export const gameResources = sqliteTable(
  "game_resources",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    resourceId: text("resource_id").notNull(),
    version: integer("version"),
  },
  (table) => [
    primaryKey({ columns: [table.gameId, table.kind, table.resourceId] }),
    index("game_resources_resource_id").on(table.resourceId),
  ],
);

export const pastOpponents = sqliteTable(
  "past_opponents",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    otherId: text("other_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastFinishedAt: integer("last_finished_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.otherId] }),
    index("past_opponents_recent").on(table.userId, table.lastFinishedAt),
    // Deleting a user cascades through other_id; blocks delete both directions (04).
    index("past_opponents_other_id").on(table.otherId),
  ],
);

export const joinLinks = sqliteTable("join_links", {
  gameId: text("game_id")
    .primaryKey()
    .references(() => games.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `emailId` (HMAC, 09 §1.1) of the normalised address; no raw address is stored. */
    emailHash: text("email_hash").notNull(),
    sentAt: integer("sent_at"),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("invites_game_id").on(table.gameId),
    index("invites_inviter_id").on(table.inviterId),
    index("invites_email_hash").on(table.emailHash),
  ],
);

export const emailSuppressions = sqliteTable("email_suppressions", {
  emailHash: text("email_hash").primaryKey(),
  reason: text("reason", { enum: ["unsubscribed", "bounced", "complained"] }).notNull(),
  createdAt: integer("created_at").notNull(),
});

export const blocks = sqliteTable(
  "blocks",
  {
    blockerId: text("blocker_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedId: text("blocked_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockerId, table.blockedId] }),
    index("blocks_blocked_id").on(table.blockedId),
  ],
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: integer("created_at").notNull(),
    lastSuccessAt: integer("last_success_at"),
  },
  (table) => [
    index("push_subscriptions_user_id").on(table.userId),
    index("push_subscriptions_session_id").on(table.sessionId),
  ],
);

export const dictionaries = sqliteTable(
  "dictionaries",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["upload", "operator"] }).notNull(),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    language: text("language").notNull(),
    alphabet: text("alphabet").notNull(),
    wordCount: integer("word_count").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    /** Server-generated `BlobStore` key; never returned by any API. */
    blobKey: text("blob_key").notNull(),
    rightsAttestedAt: integer("rights_attested_at"),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
    purgedAt: integer("purged_at"),
  },
  (table) => [index("dictionaries_owner_id").on(table.ownerId)],
);

export const rateLimits = sqliteTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.key, table.windowStart] }),
    index("rate_limits_window_start").on(table.windowStart),
  ],
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** JSON array of scopes (06 §8). */
    scopes: text("scopes").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    index("api_tokens_user_id").on(table.userId),
    index("api_tokens_created_by").on(table.createdBy),
  ],
);

export const adminAudit = sqliteTable(
  "admin_audit",
  {
    id: text("id").primaryKey(),
    /** The admin's `emailId`; deliberately not a foreign key (04). */
    actorKey: text("actor_key").notNull(),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    tokenId: text("token_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    detail: text("detail"),
    requestId: text("request_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("admin_audit_created_at").on(table.createdAt),
    index("admin_audit_actor_user_id").on(table.actorUserId),
  ],
);

export const AUTH_EVENT_TYPES = [
  "otp_requested",
  "otp_failed",
  "signed_in",
  "signed_out_all",
  "display_name_changed",
  "under_age_exit",
  "account_deleted",
  "token_created",
  "token_revoked",
  "token_rejected",
  "agent_created",
  "agent_deleted",
] as const;

export const authEvents = sqliteTable(
  "auth_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    type: text("type", { enum: AUTH_EVENT_TYPES }).notNull(),
    ipHash: text("ip_hash"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("auth_events_user_id").on(table.userId),
    index("auth_events_created_at").on(table.createdAt),
  ],
);
