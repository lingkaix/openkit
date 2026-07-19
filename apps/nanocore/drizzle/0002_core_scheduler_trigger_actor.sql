ALTER TABLE `scheduler_admission_entries` RENAME TO `scheduler_admission_entries_v1`;
--> statement-breakpoint
CREATE TABLE `scheduler_admission_entries` (
	`queue_entry_id` text PRIMARY KEY NOT NULL,
	`request_id` text,
	`trigger_actor_json` text NOT NULL,
	`workspace_cwd` text,
	`workspace_roots_json` text NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`turn_input` text NOT NULL,
	`requested_agent_id` text NOT NULL,
	`profile_ref` text NOT NULL,
	`priority_class` text NOT NULL,
	`enqueued_at` text NOT NULL,
	`effective_priority_at` text NOT NULL,
	`first_cap_deferred_at` text,
	`required_pool_constraints_json` text NOT NULL,
	`status` text NOT NULL,
	`denial_reason` text
);
--> statement-breakpoint
INSERT INTO `scheduler_admission_entries` (
	`queue_entry_id`,
	`request_id`,
	`trigger_actor_json`,
	`workspace_cwd`,
	`workspace_roots_json`,
	`workspace_id`,
	`thread_id`,
	`turn_id`,
	`turn_input`,
	`requested_agent_id`,
	`profile_ref`,
	`priority_class`,
	`enqueued_at`,
	`effective_priority_at`,
	`first_cap_deferred_at`,
	`required_pool_constraints_json`,
	`status`,
	`denial_reason`
)
SELECT
	`queue_entry_id`,
	`request_id`,
	json_object('kind', 'user', 'id', `user_id`),
	`workspace_cwd`,
	`workspace_roots_json`,
	`workspace_id`,
	`thread_id`,
	`turn_id`,
	`turn_input`,
	`requested_agent_id`,
	`profile_ref`,
	`priority_class`,
	`enqueued_at`,
	`effective_priority_at`,
	`first_cap_deferred_at`,
	`required_pool_constraints_json`,
	`status`,
	`denial_reason`
FROM `scheduler_admission_entries_v1`;
--> statement-breakpoint
DROP TABLE `scheduler_admission_entries_v1`;
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduler_admission_entries_non_terminal_turn_idx` ON `scheduler_admission_entries` (`turn_id`) WHERE `status` IN ('queued','admitted');
--> statement-breakpoint
CREATE INDEX `scheduler_admission_entries_queue_idx` ON `scheduler_admission_entries` (`status`,`priority_class`,`effective_priority_at`,`enqueued_at`);
--> statement-breakpoint
CREATE INDEX `scheduler_admission_entries_workspace_idx` ON `scheduler_admission_entries` (`workspace_id`,`status`,`enqueued_at`);
