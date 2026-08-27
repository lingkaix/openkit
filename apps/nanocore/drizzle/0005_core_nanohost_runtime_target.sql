CREATE TABLE `nanohost_runtime_targets` (
	`target_id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`deployment_id` text NOT NULL,
	`connection_generation` integer NOT NULL,
	`predecessor_fenced` integer NOT NULL,
	`ready` integer NOT NULL,
	`fresh_empty` integer NOT NULL,
	`observed_at` text NOT NULL,
	`slot_count` integer NOT NULL,
	`active_lease_id` text,
	`capacity_state` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `worker_backend_sessions` (
	`lease_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`package_snapshot_id` text NOT NULL,
	`backend_kind` text NOT NULL,
	`deployment_id` text NOT NULL,
	`backend_version` text,
	`worker_image` text NOT NULL,
	`cell_target_id` text NOT NULL,
	`placement` text NOT NULL,
	`gateway_name` text NOT NULL,
	`gateway_endpoint` text,
	`backend_session_id` text NOT NULL,
	`staging_directory_ref` text NOT NULL,
	`transient_provider_instance_id` text,
	`workspace_handoff_state` text NOT NULL,
	`state` text NOT NULL,
	`physical_cleaned_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker_backend_sessions_next` (
	`lease_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`package_snapshot_id` text NOT NULL,
	`backend_kind` text NOT NULL,
	`deployment_id` text NOT NULL,
	`backend_version` text,
	`worker_image` text,
	`cell_target_id` text,
	`placement` text,
	`gateway_name` text,
	`gateway_endpoint` text,
	`backend_session_id` text NOT NULL,
	`staging_directory_ref` text NOT NULL,
	`transient_provider_instance_id` text,
	`workspace_handoff_state` text NOT NULL,
	`state` text NOT NULL,
	`physical_cleaned_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`runtime_target_id` text,
	`backend_lineage_json` text,
	`sandbox_binding_ref` text
);
--> statement-breakpoint
INSERT INTO `worker_backend_sessions_next` (
	`lease_id`, `workspace_id`, `thread_id`, `turn_id`, `agent_session_id`,
	`package_snapshot_id`, `backend_kind`, `deployment_id`, `backend_version`,
	`worker_image`, `cell_target_id`, `placement`, `gateway_name`, `gateway_endpoint`,
	`backend_session_id`, `staging_directory_ref`, `transient_provider_instance_id`,
	`workspace_handoff_state`, `state`, `physical_cleaned_at`, `created_at`, `updated_at`
)
SELECT
	`lease_id`, `workspace_id`, `thread_id`, `turn_id`, `agent_session_id`,
	`package_snapshot_id`, `backend_kind`, `deployment_id`, `backend_version`,
	`worker_image`, `cell_target_id`, `placement`, `gateway_name`, `gateway_endpoint`,
	`backend_session_id`, `staging_directory_ref`, `transient_provider_instance_id`,
	`workspace_handoff_state`, `state`, `physical_cleaned_at`, `created_at`, `updated_at`
FROM `worker_backend_sessions`;
--> statement-breakpoint
DROP TABLE `worker_backend_sessions`;
--> statement-breakpoint
ALTER TABLE `worker_backend_sessions_next` RENAME TO `worker_backend_sessions`;
--> statement-breakpoint
CREATE INDEX `worker_backend_sessions_lineage_idx` ON `worker_backend_sessions` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`);
--> statement-breakpoint
CREATE INDEX `worker_backend_sessions_state_idx` ON `worker_backend_sessions` (`state`,`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_backend_sessions_package_idx` ON `worker_backend_sessions` (`package_snapshot_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_backend_sessions_staging_idx` ON `worker_backend_sessions` (`staging_directory_ref`);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_backend_sessions_backend_session_idx` ON `worker_backend_sessions` (`backend_session_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_backend_sessions_sandbox_binding_idx` ON `worker_backend_sessions` (`sandbox_binding_ref`) WHERE `sandbox_binding_ref` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_backend_sessions_transient_provider_idx` ON `worker_backend_sessions` (`transient_provider_instance_id`) WHERE `transient_provider_instance_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_backend_sessions_named_target_idx` ON `worker_backend_sessions` (`backend_kind`,`gateway_name`,`backend_session_id`) WHERE `gateway_endpoint` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_backend_sessions_endpoint_target_idx` ON `worker_backend_sessions` (`backend_kind`,`gateway_endpoint`,`backend_session_id`) WHERE `gateway_endpoint` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_backend_sessions_named_provider_idx` ON `worker_backend_sessions` (`backend_kind`,`gateway_name`,`transient_provider_instance_id`) WHERE `gateway_endpoint` IS NULL AND `transient_provider_instance_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_backend_sessions_endpoint_provider_idx` ON `worker_backend_sessions` (`backend_kind`,`gateway_endpoint`,`transient_provider_instance_id`) WHERE `gateway_endpoint` IS NOT NULL AND `transient_provider_instance_id` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduler_session_leases` ADD `worker_control_token_hash` text;
--> statement-breakpoint
ALTER TABLE `scheduler_session_leases` ADD `worker_inference_token_hash` text;
