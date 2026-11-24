CREATE TABLE `admin_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_key` text NOT NULL,
	`actor_user_id` text,
	`token_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`detail` text,
	`request_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `admin_audit_created_at` ON `admin_audit` (`created_at`);--> statement-breakpoint
CREATE INDEX `admin_audit_actor_user_id` ON `admin_audit` (`actor_user_id`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_by` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_user_id` ON `api_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `api_tokens_created_by` ON `api_tokens` (`created_by`);--> statement-breakpoint
CREATE TABLE `auth_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`type` text NOT NULL,
	`ip_hash` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `auth_events_user_id` ON `auth_events` (`user_id`);--> statement-breakpoint
CREATE INDEX `auth_events_created_at` ON `auth_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `blocks` (
	`blocker_id` text NOT NULL,
	`blocked_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`blocker_id`, `blocked_id`),
	FOREIGN KEY (`blocker_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocked_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `blocks_blocked_id` ON `blocks` (`blocked_id`);--> statement-breakpoint
CREATE TABLE `dictionaries` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`owner_id` text,
	`name` text NOT NULL,
	`language` text NOT NULL,
	`alphabet` text NOT NULL,
	`word_count` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`blob_key` text NOT NULL,
	`rights_attested_at` integer,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`purged_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `dictionaries_owner_id` ON `dictionaries` (`owner_id`);--> statement-breakpoint
CREATE TABLE `email_suppressions` (
	`email_hash` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `game_actions` (
	`game_id` text NOT NULL,
	`seq` integer NOT NULL,
	`seat` integer NOT NULL,
	`kind` text NOT NULL,
	`action` text,
	`record` text NOT NULL,
	`describe` text NOT NULL,
	`rng` text,
	`via` text DEFAULT 'app' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `seq`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `game_players` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`seat` integer,
	`user_id` text,
	`invite_email` text,
	`state` text NOT NULL,
	`out_reason` text,
	`joined_via` text,
	`delivery` text DEFAULT 'normal' NOT NULL,
	`removed_at` integer,
	`joined_at` integer,
	`to_act` integer DEFAULT 0 NOT NULL,
	`to_act_since` integer,
	`acted_once` integer DEFAULT 0 NOT NULL,
	`rank` integer,
	`score` integer,
	`last_seen_version` integer DEFAULT 0 NOT NULL,
	`last_nudged_at` integer,
	`timeout_reminders_sent` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_players_game_user` ON `game_players` (`game_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `game_players_game_seat` ON `game_players` (`game_id`,`seat`);--> statement-breakpoint
CREATE INDEX `game_players_user_to_act` ON `game_players` (`user_id`,`to_act`);--> statement-breakpoint
CREATE INDEX `game_players_user_state` ON `game_players` (`user_id`,`state`);--> statement-breakpoint
CREATE INDEX `game_players_invite_email` ON `game_players` (`invite_email`);--> statement-breakpoint
CREATE TABLE `game_resources` (
	`game_id` text NOT NULL,
	`kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`version` integer,
	PRIMARY KEY(`game_id`, `kind`, `resource_id`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `game_resources_resource_id` ON `game_resources` (`resource_id`);--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`game_type` text NOT NULL,
	`game_version` integer NOT NULL,
	`options` text NOT NULL,
	`status` text NOT NULL,
	`created_by` text,
	`seats` integer NOT NULL,
	`turn_timeout_days` integer NOT NULL,
	`seat_order` text NOT NULL,
	`ai_assistance` text NOT NULL,
	`state` text,
	`setup_rng` text,
	`final_views` text,
	`version` integer DEFAULT 0 NOT NULL,
	`write_token` text,
	`action_count` integer DEFAULT 0 NOT NULL,
	`last_action_at` integer NOT NULL,
	`end_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `games_status` ON `games` (`status`,`game_type`);--> statement-breakpoint
CREATE INDEX `games_created_by` ON `games` (`created_by`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`inviter_id` text NOT NULL,
	`email_hash` text NOT NULL,
	`sent_at` integer,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invites_game_id` ON `invites` (`game_id`);--> statement-breakpoint
CREATE INDEX `invites_inviter_id` ON `invites` (`inviter_id`);--> statement-breakpoint
CREATE INDEX `invites_email_hash` ON `invites` (`email_hash`);--> statement-breakpoint
CREATE TABLE `join_links` (
	`game_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `join_links_token_hash_unique` ON `join_links` (`token_hash`);--> statement-breakpoint
CREATE TABLE `otp_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`purpose` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`emailed` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `otp_challenges_email` ON `otp_challenges` (`email`,`purpose`);--> statement-breakpoint
CREATE TABLE `past_opponents` (
	`user_id` text NOT NULL,
	`other_id` text NOT NULL,
	`last_finished_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `other_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`other_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `past_opponents_recent` ON `past_opponents` (`user_id`,`last_finished_at`);--> statement-breakpoint
CREATE INDEX `past_opponents_other_id` ON `past_opponents` (`other_id`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_success_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_id` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_session_id` ON `push_subscriptions` (`session_id`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`key`, `window_start`)
);
--> statement-breakpoint
CREATE INDEX `rate_limits_window_start` ON `rate_limits` (`window_start`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_id` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'human' NOT NULL,
	`owner_user_id` text,
	`email` text,
	`display_name` text,
	`settings` text DEFAULT '{}' NOT NULL,
	`age_attested_at` integer,
	`age_attested_min_age` integer,
	`onboarded_at` integer,
	`deletion_requested_at` integer,
	`suspended_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_owner_user_id` ON `users` (`owner_user_id`);