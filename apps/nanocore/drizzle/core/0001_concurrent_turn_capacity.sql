-- One-way capacity migration. Native migrate already holds a transaction with foreign keys on.
-- Retain all child rows before the parent rebuild so CASCADE cannot discard binding evidence.
CREATE TEMP TABLE capacity_sandbox_rows AS SELECT * FROM sandbox_runtime_records;
--> statement-breakpoint

CREATE TEMP TABLE capacity_harness_rows AS SELECT * FROM harness_instance_records;
--> statement-breakpoint

CREATE TEMP TABLE capacity_binding_rows AS SELECT * FROM agent_session_runtime_bindings;
--> statement-breakpoint

DROP TABLE harness_instance_records;
--> statement-breakpoint

DROP TABLE sandbox_runtime_records;
--> statement-breakpoint

CREATE TABLE `sandbox_runtime_records` (
	`sandbox_runtime_id` text PRIMARY KEY NOT NULL,
	`runtime_target_id` text NOT NULL REFERENCES `nanohost_runtime_targets`(`target_id`) ON DELETE RESTRICT,
	`origin_physical_epoch` text NOT NULL,
	`sandbox_binding_ref` text NOT NULL,
	`sandbox_integration_binding_ref` text NOT NULL,
	`sandbox_compatibility_key` text NOT NULL,
	`image_digest` text NOT NULL,
	`environment_class` text NOT NULL,
	`max_open_sessions` integer NOT NULL,
	`max_harnesses` integer NOT NULL,
	`max_active_turns` integer NOT NULL,
	`lifecycle_state` text NOT NULL,
	`health_state` text NOT NULL,
	`drain_state` text NOT NULL,
	`cleanup_state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `sandbox_runtime_records_open_capacity_check` CHECK (`max_open_sessions` >= 2),
	CONSTRAINT `sandbox_runtime_records_harness_capacity_check` CHECK (`max_harnesses` >= 2),
	CONSTRAINT `sandbox_runtime_records_turn_capacity_check` CHECK (`max_active_turns` >= 1)
);
--> statement-breakpoint

CREATE TABLE `harness_instance_records` (
	`harness_instance_id` text PRIMARY KEY NOT NULL,
	`sandbox_runtime_id` text NOT NULL REFERENCES `sandbox_runtime_records`(`sandbox_runtime_id`) ON DELETE CASCADE,
	`harness_binding_ref` text NOT NULL,
	`harness_compatibility_key` text NOT NULL,
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
	CONSTRAINT `harness_instance_records_turn_capacity_check` CHECK (`max_active_turns` >= 1 AND `active_turn_count` >= 0 AND `active_turn_count` <= `max_active_turns`)
);
--> statement-breakpoint

INSERT INTO sandbox_runtime_records SELECT * FROM capacity_sandbox_rows;
--> statement-breakpoint

INSERT INTO harness_instance_records SELECT * FROM capacity_harness_rows;
--> statement-breakpoint

INSERT INTO agent_session_runtime_bindings SELECT * FROM capacity_binding_rows;
--> statement-breakpoint

CREATE UNIQUE INDEX `harness_instance_records_binding_idx` ON `harness_instance_records` (`harness_binding_ref`);
--> statement-breakpoint

CREATE UNIQUE INDEX `harness_instance_records_compatibility_idx` ON `harness_instance_records` (`sandbox_runtime_id`,`harness_compatibility_key`);
--> statement-breakpoint

CREATE UNIQUE INDEX `sandbox_runtime_records_binding_idx` ON `sandbox_runtime_records` (`sandbox_binding_ref`);
--> statement-breakpoint

CREATE UNIQUE INDEX `sandbox_runtime_records_integration_binding_idx` ON `sandbox_runtime_records` (`sandbox_integration_binding_ref`);
--> statement-breakpoint

CREATE INDEX `sandbox_runtime_records_target_idx` ON `sandbox_runtime_records` (`runtime_target_id`,`lifecycle_state`);
--> statement-breakpoint

DROP TABLE capacity_binding_rows;
--> statement-breakpoint

DROP TABLE capacity_harness_rows;
--> statement-breakpoint

DROP TABLE capacity_sandbox_rows;
