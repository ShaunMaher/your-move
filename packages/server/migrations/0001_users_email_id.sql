ALTER TABLE `users` ADD `email_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_id_unique` ON `users` (`email_id`);