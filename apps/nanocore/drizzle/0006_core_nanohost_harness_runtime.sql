CREATE TABLE `sandbox_runtime_records` (
	`sandbox_runtime_id` text PRIMARY KEY NOT NULL,
	`runtime_target_id` text NOT NULL REFERENCES `nanohost_runtime_targets`(`target_id`) ON DELETE RESTRICT,
	`sandbox_binding_ref` text NOT NULL,
	`sandbox_compatibility_key` text NOT NULL,
	`image_digest` text NOT NULL,
	`environment_class` text NOT NULL,
	`max_open_sessions` integer NOT NULL,
	`max_active_turns` integer NOT NULL,
	`lifecycle_state` text NOT NULL,
	`health_state` text NOT NULL,
	`drain_state` text NOT NULL,
	`cleanup_state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `sandbox_runtime_records_open_capacity_check` CHECK (`max_open_sessions` >= 2),
	CONSTRAINT `sandbox_runtime_records_turn_capacity_check` CHECK (`max_active_turns` = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sandbox_runtime_records_binding_idx` ON `sandbox_runtime_records` (`sandbox_binding_ref`);
--> statement-breakpoint
CREATE INDEX `sandbox_runtime_records_target_idx` ON `sandbox_runtime_records` (`runtime_target_id`,`lifecycle_state`);
--> statement-breakpoint
CREATE TABLE `harness_instance_records` (
	`harness_instance_id` text PRIMARY KEY NOT NULL,
	`sandbox_runtime_id` text NOT NULL REFERENCES `sandbox_runtime_records`(`sandbox_runtime_id`) ON DELETE CASCADE,
	`harness_binding_ref` text NOT NULL,
	`runtime_family` text NOT NULL,
	`adapter_id` text NOT NULL,
	`adapter_version` text NOT NULL,
	`protocol_version` integer NOT NULL,
	`capabilities_json` text NOT NULL,
	`max_open_sessions` integer NOT NULL,
	`max_active_turns` integer NOT NULL,
	`open_session_count` integer NOT NULL,
	`active_turn_count` integer NOT NULL,
	`lifecycle_state` text NOT NULL,
	`drain_state` text NOT NULL,
	`next_sequence` integer NOT NULL,
	`operation_state` text NOT NULL,
	`operation_id` text,
	`operation_sequence` integer,
	`operation` text,
	`command_body_json` text,
	`command_fingerprint` text,
	`result_json` text,
	`result_fingerprint` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `harness_instance_records_protocol_check` CHECK (`protocol_version` = 1),
	CONSTRAINT `harness_instance_records_open_capacity_check` CHECK (`max_open_sessions` >= 2 AND `open_session_count` >= 0 AND `open_session_count` <= `max_open_sessions`),
	CONSTRAINT `harness_instance_records_turn_capacity_check` CHECK (`max_active_turns` = 1 AND `active_turn_count` >= 0 AND `active_turn_count` <= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `harness_instance_records_sandbox_idx` ON `harness_instance_records` (`sandbox_runtime_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `harness_instance_records_binding_idx` ON `harness_instance_records` (`harness_binding_ref`);
--> statement-breakpoint
CREATE TABLE `agent_session_runtime_bindings` (
	`agent_session_runtime_binding_id` text PRIMARY KEY NOT NULL,
	`harness_instance_id` text NOT NULL REFERENCES `harness_instance_records`(`harness_instance_id`) ON DELETE CASCADE,
	`agent_session_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`agent_session_compatibility_key` text NOT NULL,
	`effective_setup_generation` integer NOT NULL,
	`native_handle_state` text NOT NULL,
	`native_handle_digest` text,
	`lifecycle_state` text NOT NULL,
	`current_turn_id` text,
	`current_lease_id` text,
	`next_turn_sequence` integer NOT NULL,
	`cleanup_state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `agent_session_runtime_bindings_setup_generation_check` CHECK (`effective_setup_generation` >= 1),
	CONSTRAINT `agent_session_runtime_bindings_turn_sequence_check` CHECK (`next_turn_sequence` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_runtime_bindings_session_idx` ON `agent_session_runtime_bindings` (`agent_session_id`);
--> statement-breakpoint
CREATE INDEX `agent_session_runtime_bindings_harness_idx` ON `agent_session_runtime_bindings` (`harness_instance_id`,`lifecycle_state`);
