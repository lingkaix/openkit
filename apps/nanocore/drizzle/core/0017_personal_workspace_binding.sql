ALTER TABLE `users` ADD COLUMN `personal_workspace_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_personal_workspace_id_unique` ON `users` (`personal_workspace_id`);
