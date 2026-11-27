ALTER TABLE `games` ADD `rematch_game_id` text REFERENCES games(id);--> statement-breakpoint
CREATE UNIQUE INDEX `games_rematch_game_id_unique` ON `games` (`rematch_game_id`);