CREATE TABLE `agent_session_runtime_binding_image_digests` (
	`agent_session_runtime_binding_id` text NOT NULL,
	`image_digest` text NOT NULL,
	`copied_at` text NOT NULL,
	PRIMARY KEY (`agent_session_runtime_binding_id`, `image_digest`)
);
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
	`current_attempt_id` text,
	`next_turn_sequence` integer NOT NULL,
	`cleanup_state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`image_digest` text NOT NULL,
	`native_environment_json` text,
	`native_environment_applied` integer DEFAULT 0 NOT NULL,
	`inference_loopback_credential_digest` text,
	`capability_loopback_credential_digest` text,
	`runtime_env_check_versions_json` text, `schema_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `agent_session_runtime_bindings_loopback_digest_check` CHECK ((`inference_loopback_credential_digest` IS NULL) = (`capability_loopback_credential_digest` IS NULL) AND (`inference_loopback_credential_digest` IS NULL OR `inference_loopback_credential_digest` <> `capability_loopback_credential_digest`)),
	CONSTRAINT `agent_session_runtime_bindings_setup_generation_check` CHECK (`effective_setup_generation` >= 1),
	CONSTRAINT `agent_session_runtime_bindings_turn_sequence_check` CHECK (`next_turn_sequence` >= 0)
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
	`updated_at` text NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `harness_instance_records_protocol_check` CHECK (`protocol_version` = 1),
	CONSTRAINT `harness_instance_records_open_capacity_check` CHECK (`max_open_sessions` >= 2 AND `open_session_count` >= 0 AND `open_session_count` <= `max_open_sessions`),
	CONSTRAINT `harness_instance_records_turn_capacity_check` CHECK (`max_active_turns` >= 1 AND `active_turn_count` >= 0 AND `active_turn_count` <= `max_active_turns`)
);
--> statement-breakpoint
CREATE TABLE `nanohost_integration_identities` (
	`identity_id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`decommissioned_at` text
);
--> statement-breakpoint
CREATE TABLE `nanohost_runtime_targets` (
	`target_id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`deployment_id` text NOT NULL,
	`connection_generation` integer NOT NULL,
	`predecessor_fenced` integer NOT NULL,
	`ready` integer NOT NULL,
	`fresh_empty` integer NOT NULL,
	`physical_epoch` text,
	`observed_at` text NOT NULL,
	`slot_count` integer NOT NULL,
	`last_fresh_ready_at` text,
	`vault_epoch_fence_json` text
);
--> statement-breakpoint
CREATE TABLE `nanohost_transport_tokens` (
	`token_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`owner_nanohost_identity_id` text NOT NULL,
	`token_type` text NOT NULL,
	`scope` text NOT NULL,
	`deployment_id` text NOT NULL,
	`status` text NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`predecessor_token_id` text,
	`rotation_overlap_expires_at` text,
	`responsible_server_admin_actor_id` text NOT NULL,
	`last_used_at` text,
	`last_used_channel` text,
	`last_used_source` text
);
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
CREATE TABLE `worker_backend_sessions` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`package_snapshot_id` text NOT NULL,
	`backend_kind` text NOT NULL,
	`deployment_id` text NOT NULL,
	`backend_version` text,
	`worker_image` text,
	`placement` text,
	`backend_session_id` text NOT NULL,
	`staging_directory_ref` text NOT NULL,
	`transient_provider_instance_id` text,
	`workspace_handoff_state` text NOT NULL,
	`state` text NOT NULL,
	`physical_cleaned_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`runtime_target_id` text,
	`origin_physical_epoch` text NOT NULL,
	`backend_lineage_json` text,
	`sandbox_binding_ref` text,
	`schema_version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker_control_records` (
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`package_snapshot_id` text NOT NULL,
	`request_id` text,
	`operation` text NOT NULL,
	`record_key` text NOT NULL,
	`sequence` integer,
	`record_json` text NOT NULL,
	`accepted_at` text NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`agent_session_id`, `package_snapshot_id`, `operation`, `record_key`)
);
--> statement-breakpoint
CREATE TABLE `worker_control_rejected_evidence` (
	`rejection_id` text NOT NULL PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`package_snapshot_id` text NOT NULL,
	`request_id` text,
	`route` text NOT NULL,
	`operation` text NOT NULL,
	`error_code` text NOT NULL,
	`http_status` integer NOT NULL,
	`message` text NOT NULL,
	`rejected_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker_control_sequence_fingerprints` (
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`package_snapshot_id` text NOT NULL,
	`request_id` text,
	`operation` text NOT NULL,
	`sequence` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`accepted_at` text NOT NULL,
	PRIMARY KEY(`agent_session_id`, `package_snapshot_id`, `operation`, `sequence`)
);
--> statement-breakpoint
CREATE TABLE `worker_image_settlements` (
  `request_id` text PRIMARY KEY NOT NULL,
  `operation` text NOT NULL CHECK (`operation` IN ('image.acquire', 'image.build')),
  `authored_artifact_id` text NOT NULL,
  `authored_artifact_version` integer NOT NULL CHECK (`authored_artifact_version` = 1),
  `authored_content_digest` text NOT NULL,
  `input_digest` text NOT NULL,
  `outcome` text NOT NULL,
  `image_digest` text,
  `failure_code` text,
	`native_environment_json` text,
  `created_at` text NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
  CHECK ((`outcome` = 'success' AND `image_digest` IS NOT NULL AND `failure_code` IS NULL)
      OR (`outcome` = 'failure' AND `image_digest` IS NULL AND `failure_code` = 'effect_failed'))
);
--> statement-breakpoint
CREATE TABLE `worker_storage_bindings` (
	`storage_ref` text PRIMARY KEY NOT NULL,
	`runtime_target_id` text NOT NULL REFERENCES `nanohost_runtime_targets`(`target_id`) ON DELETE RESTRICT,
	`deployment_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`scope_digest` text NOT NULL,
	`layout_digest` text NOT NULL,
	`layout_family` text,
	`layout_version` text,
	`platform_os` text NOT NULL,
	`platform_architecture` text NOT NULL,
	`owner_uid` integer NOT NULL,
	`owner_gid` integer NOT NULL,
	`working_directory` text NOT NULL,
	`targets_json` text NOT NULL,
	`revision` integer NOT NULL,
	`attachment_generation` integer NOT NULL,
	`state` text NOT NULL,
	`current_agent_session_id` text,
	`current_thread_id` text,
	`current_work_slot_ref` text,
	`current_sandbox_binding_ref` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`purged_at` text, `schema_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `worker_storage_bindings_revision_check` CHECK (`revision` >= 1),
	CONSTRAINT `worker_storage_bindings_generation_check` CHECK (`attachment_generation` >= 0),
	CONSTRAINT `worker_storage_bindings_owner_check` CHECK (`owner_uid` >= 0 AND `owner_gid` >= 0),
	CONSTRAINT `worker_storage_bindings_state_check` CHECK (`state` IN ('idle', 'reserved', 'attached', 'unknown', 'purge-pending', 'purged')),
	CONSTRAINT `worker_storage_bindings_attachment_check` CHECK (
		(`state` = 'idle' AND `current_agent_session_id` IS NULL AND `current_thread_id` IS NULL AND `current_work_slot_ref` IS NULL AND `current_sandbox_binding_ref` IS NULL)
		OR (`state` = 'reserved' AND `current_agent_session_id` IS NOT NULL AND `current_thread_id` IS NOT NULL AND `current_work_slot_ref` IS NOT NULL AND `current_sandbox_binding_ref` IS NULL)
		OR (`state` = 'attached' AND `current_agent_session_id` IS NOT NULL AND `current_thread_id` IS NOT NULL AND `current_work_slot_ref` IS NOT NULL)
		OR (`state` = 'unknown' AND ((`current_agent_session_id` IS NOT NULL AND `current_thread_id` IS NOT NULL AND `current_work_slot_ref` IS NOT NULL) OR (`current_agent_session_id` IS NULL AND `current_thread_id` IS NULL AND `current_work_slot_ref` IS NULL AND `current_sandbox_binding_ref` IS NULL)))
		OR (`state` IN ('purge-pending', 'purged') AND `current_agent_session_id` IS NULL AND `current_thread_id` IS NULL AND `current_work_slot_ref` IS NULL AND `current_sandbox_binding_ref` IS NULL)
	),
	CONSTRAINT `worker_storage_bindings_purge_check` CHECK ((`state` = 'purged') = (`purged_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `worker_storage_contributors` (
	`contributor_ref` text PRIMARY KEY NOT NULL,
	`storage_ref` text NOT NULL REFERENCES `worker_storage_bindings`(`storage_ref`) ON DELETE CASCADE,
	`attachment_generation` integer NOT NULL,
	`workspace_id` text NOT NULL,
	`responsible_user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`goal_id` text,
	`task_id` text,
	`purpose` text NOT NULL,
	`work_slot_ref` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `worker_storage_contributors_generation_check` CHECK (`attachment_generation` >= 1),
	CONSTRAINT `worker_storage_contributors_purpose_check` CHECK (`purpose` IN ('work', 'independent-review'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_runtime_bindings_current_thread_idx`
ON `agent_session_runtime_bindings` (`workspace_id`,`thread_id`)
WHERE `lifecycle_state` NOT IN ('closed','failed');
--> statement-breakpoint
CREATE INDEX `agent_session_runtime_bindings_harness_idx` ON `agent_session_runtime_bindings` (`harness_instance_id`,`lifecycle_state`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_runtime_bindings_session_idx` ON `agent_session_runtime_bindings` (`agent_session_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `harness_instance_records_binding_idx` ON `harness_instance_records` (`harness_binding_ref`);
--> statement-breakpoint
CREATE UNIQUE INDEX `harness_instance_records_compatibility_idx` ON `harness_instance_records` (`sandbox_runtime_id`,`harness_compatibility_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `nanohost_integration_identities_deployment_idx` ON `nanohost_integration_identities` (`deployment_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `nanohost_transport_tokens_hash_idx` ON `nanohost_transport_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `nanohost_transport_tokens_owner_idx` ON `nanohost_transport_tokens` (`owner_nanohost_identity_id`,`deployment_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `sandbox_runtime_records_binding_idx` ON `sandbox_runtime_records` (`sandbox_binding_ref`);
--> statement-breakpoint
CREATE UNIQUE INDEX `sandbox_runtime_records_integration_binding_idx` ON `sandbox_runtime_records` (`sandbox_integration_binding_ref`);
--> statement-breakpoint
CREATE INDEX `sandbox_runtime_records_target_idx` ON `sandbox_runtime_records` (`runtime_target_id`,`lifecycle_state`);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_backend_sessions_backend_session_idx` ON `worker_backend_sessions` (`backend_session_id`);
--> statement-breakpoint
CREATE INDEX `worker_backend_sessions_lineage_idx` ON `worker_backend_sessions` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_backend_sessions_package_idx` ON `worker_backend_sessions` (`package_snapshot_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_backend_sessions_sandbox_binding_idx` ON `worker_backend_sessions` (`sandbox_binding_ref`) WHERE `sandbox_binding_ref` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_backend_sessions_staging_idx` ON `worker_backend_sessions` (`staging_directory_ref`);
--> statement-breakpoint
CREATE INDEX `worker_backend_sessions_state_idx` ON `worker_backend_sessions` (`state`,`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_backend_sessions_transient_provider_idx` ON `worker_backend_sessions` (`transient_provider_instance_id`) WHERE `transient_provider_instance_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `worker_control_records_scope_idx` ON `worker_control_records` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`,`operation`,`record_key`);
--> statement-breakpoint
CREATE INDEX `worker_control_rejected_evidence_scope_idx` ON `worker_control_rejected_evidence` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`,`operation`,`error_code`);
--> statement-breakpoint
CREATE INDEX `worker_control_sequence_fingerprints_scope_idx` ON `worker_control_sequence_fingerprints` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`,`operation`,`sequence`);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_storage_bindings_current_sandbox_idx` ON `worker_storage_bindings` (`current_sandbox_binding_ref`);
--> statement-breakpoint
CREATE INDEX `worker_storage_bindings_target_idx` ON `worker_storage_bindings` (`runtime_target_id`,`state`);
--> statement-breakpoint
CREATE INDEX `worker_storage_bindings_workspace_idx` ON `worker_storage_bindings` (`workspace_id`,`state`);
--> statement-breakpoint
CREATE INDEX `worker_storage_contributors_audience_idx` ON `worker_storage_contributors` (`workspace_id`,`responsible_user_id`,`thread_id`);
--> statement-breakpoint
CREATE INDEX `worker_storage_contributors_generation_idx` ON `worker_storage_contributors` (`storage_ref`,`attachment_generation`);
--> statement-breakpoint
CREATE INDEX `worker_storage_contributors_slot_idx` ON `worker_storage_contributors` (`storage_ref`,`work_slot_ref`);
