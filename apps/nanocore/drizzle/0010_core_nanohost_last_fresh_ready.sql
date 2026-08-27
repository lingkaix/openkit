ALTER TABLE `nanohost_runtime_targets` ADD `last_fresh_ready_at` text;
--> statement-breakpoint
UPDATE `nanohost_runtime_targets`
SET `last_fresh_ready_at` = `observed_at`
WHERE `predecessor_fenced` = 1 AND `ready` = 1 AND `fresh_empty` = 1;
