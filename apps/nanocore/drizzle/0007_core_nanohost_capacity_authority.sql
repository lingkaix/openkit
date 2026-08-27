CREATE TABLE `nanohost_runtime_target_capacity_migration_guard` (
	`invalid_row_count` integer NOT NULL,
	CONSTRAINT `nanohost_runtime_target_capacity_migration_guard_check` CHECK (`invalid_row_count` = 0)
);
--> statement-breakpoint
INSERT INTO `nanohost_runtime_target_capacity_migration_guard` (`invalid_row_count`)
SELECT COUNT(*)
FROM `nanohost_runtime_targets`
WHERE `active_lease_id` IS NOT NULL
	OR `capacity_state` NOT IN ('available', 'unavailable')
	OR `capacity_state` != CASE
		WHEN `predecessor_fenced` = 1 AND `ready` = 1 AND `fresh_empty` = 1 THEN 'available'
		ELSE 'unavailable'
	END;
--> statement-breakpoint
DROP TABLE `nanohost_runtime_target_capacity_migration_guard`;
--> statement-breakpoint
ALTER TABLE `nanohost_runtime_targets` DROP COLUMN `active_lease_id`;
--> statement-breakpoint
ALTER TABLE `nanohost_runtime_targets` DROP COLUMN `capacity_state`;
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_runtime_bindings_current_thread_idx`
ON `agent_session_runtime_bindings` (`workspace_id`,`thread_id`)
WHERE `lifecycle_state` NOT IN ('closed','failed');
