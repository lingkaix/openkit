ALTER TABLE `audit_events`
ADD COLUMN `actor_json` text;
--> statement-breakpoint
ALTER TABLE `audit_events`
ADD COLUMN `subject_json` text;
--> statement-breakpoint
ALTER TABLE `audit_events`
ADD COLUMN `resource_revision` integer
CHECK (`resource_revision` IS NULL OR (typeof(`resource_revision`) = 'integer' AND `resource_revision` > 0));
--> statement-breakpoint
CREATE UNIQUE INDEX `permission_decisions_terminal_approval_idx`
ON `permission_decisions` (`approval_id`)
WHERE `owner_scope` = 'workspace'
  AND `approval_id` IS NOT NULL
  AND `result` IN ('allow', 'deny');
