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
  `created_at` text NOT NULL,
  CHECK ((`outcome` = 'success' AND `image_digest` IS NOT NULL AND `failure_code` IS NULL)
      OR (`outcome` = 'failure' AND `image_digest` IS NULL AND `failure_code` = 'effect_failed'))
);

--> statement-breakpoint

CREATE TABLE `account` (
  `id` text PRIMARY KEY NOT NULL,
  `account_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `user_id` text NOT NULL,
  `access_token` text,
  `refresh_token` text,
  `id_token` text,
  `access_token_expires_at` integer,
  `refresh_token_expires_at` integer,
  `scope` text,
  `password` text,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
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
	`current_lease_id` text,
	`next_turn_sequence` integer NOT NULL,
	`cleanup_state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`image_digest` text NOT NULL,
	CONSTRAINT `agent_session_runtime_bindings_setup_generation_check` CHECK (`effective_setup_generation` >= 1),
	CONSTRAINT `agent_session_runtime_bindings_turn_sequence_check` CHECK (`next_turn_sequence` >= 0)
);

--> statement-breakpoint

CREATE TABLE `agent_session_runtime_binding_image_digests` (
	`agent_session_runtime_binding_id` text NOT NULL,
	`image_digest` text NOT NULL,
	`copied_at` text NOT NULL,
	PRIMARY KEY (`agent_session_runtime_binding_id`, `image_digest`)
);

--> statement-breakpoint

CREATE TABLE `audit_events` (
	`audit_event_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`protocol_version` text,
	`thread_id` text,
	`turn_id` text,
	`item_id` text,
	`capability_call_id` text,
	`request_id` text,
	`agent_id` text,
	`agent_session_id` text,
	`category` text NOT NULL,
	`action` text NOT NULL,
	`resource` text,
	`outcome` text NOT NULL,
	`severity` text NOT NULL,
	`summary` text NOT NULL,
	`error_code` text,
	`created_at` text NOT NULL,
	`occurred_at` text NOT NULL
, `permission_decision_id` text, `vault_grant_id` text, `actor_json` text, `subject_json` text, `resource_revision` integer
CHECK (`resource_revision` IS NULL OR (typeof(`resource_revision`) = 'integer' AND `resource_revision` > 0)));

--> statement-breakpoint

CREATE TABLE `boot_audit_events` (
	`boot_event_id` text PRIMARY KEY NOT NULL,
	`boot_id` text NOT NULL,
	`event_type` text NOT NULL,
	`outcome` text NOT NULL,
	`accepting_product_work` integer NOT NULL,
	`phase_outcomes_json` text NOT NULL,
	`readiness_json` text NOT NULL,
	`created_at` text NOT NULL
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
	CONSTRAINT `harness_instance_records_turn_capacity_check` CHECK (`max_active_turns` = 1 AND `active_turn_count` >= 0 AND `active_turn_count` <= 1)
);

--> statement-breakpoint

CREATE TABLE `idempotency_requests` (
  `request_key` text PRIMARY KEY NOT NULL,
  `command_name` text NOT NULL,
  `request_id` text NOT NULL,
  `scope_json` text NOT NULL,
  `input_hash` text NOT NULL,
  `response_kind` text NOT NULL,
  `response_id` text NOT NULL,
  `response_json` text,
  `created_at` text NOT NULL,
  `expires_at` text NOT NULL
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
	`slot_count` integer NOT NULL, `last_fresh_ready_at` text);

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

CREATE TABLE `openkit_access_tokens` (
	`token_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`scope` text NOT NULL,
	`workspace_ids_json` text NOT NULL,
	`status` text NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`predecessor_token_id` text,
	`rotated_grace_expires_at` text,
	`last_used_at` text,
	`last_used_channel` text,
	`last_used_source` text,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint

CREATE TABLE `permission_decisions` (
	`decision_id` text PRIMARY KEY NOT NULL,
	`owner_scope` text NOT NULL,
	`workspace_id` text,
	`policy_engine_version` text NOT NULL,
	`policy_snapshot_id` text NOT NULL,
	`subject_summary_json` text NOT NULL,
	`action` text NOT NULL,
	`resource_summary_json` text NOT NULL,
	`context_summary_json` text NOT NULL,
	`result` text NOT NULL,
	`reason_code` text NOT NULL,
	`enforcement_point` text NOT NULL,
	`required_approval_kind` text,
	`approval_id` text,
	`audit_event_id` text,
	`created_at` text NOT NULL
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
	`updated_at` text NOT NULL, `pinned_goal_id` text,
	CONSTRAINT `sandbox_runtime_records_open_capacity_check` CHECK (`max_open_sessions` >= 2),
	CONSTRAINT `sandbox_runtime_records_harness_capacity_check` CHECK (`max_harnesses` >= 2),
	CONSTRAINT `sandbox_runtime_records_turn_capacity_check` CHECK (`max_active_turns` = 1)
);

--> statement-breakpoint

CREATE TABLE `scheduler_admission_entries` (
	`queue_entry_id` text PRIMARY KEY NOT NULL,
	`request_id` text,
	`trigger_actor_json` text NOT NULL,
	`server_admin_token_id` text,
	`workspace_cwd` text,
	`workspace_roots_json` text NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`turn_input` text NOT NULL,
	`worker_storage_choice_json` text,
	`requested_agent_id` text NOT NULL,
	`profile_ref` text,
	`model_id` text,
	`priority_class` text NOT NULL,
	`enqueued_at` text NOT NULL,
	`effective_priority_at` text NOT NULL,
	`first_cap_deferred_at` text,
	`required_pool_constraints_json` text NOT NULL,
	`status` text NOT NULL,
	`denial_reason` text
);

--> statement-breakpoint

CREATE TABLE `scheduler_capacity_records` (
	`target_id` text PRIMARY KEY NOT NULL,
	`pool_id` text NOT NULL,
	`capacity_class` text NOT NULL,
	`concurrency_ceiling` integer NOT NULL,
	`in_use_count` integer NOT NULL,
	`queue_depth` integer NOT NULL,
	`observed_at` text NOT NULL,
	`observation_source` text NOT NULL,
	`version` integer NOT NULL
);

--> statement-breakpoint

CREATE TABLE `scheduler_orphan_worker_evidence` (
	`evidence_id` text NOT NULL PRIMARY KEY,
	`lease_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`package_snapshot_id` text NOT NULL,
	`pool_id` text NOT NULL,
	`target_id` text NOT NULL,
	`reason` text NOT NULL,
	`scheduler_epoch` integer NOT NULL,
	`heartbeat_deadline` text NOT NULL,
	`last_accepted_heartbeat_at` text,
	`recorded_at` text NOT NULL
);

--> statement-breakpoint

CREATE TABLE `scheduler_placement_plans` (
	`plan_id` text PRIMARY KEY NOT NULL,
	`queue_entry_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`selected_pool_id` text NOT NULL,
	`selected_target_id` text NOT NULL,
	`planned_lease_duration_ms` integer NOT NULL,
	`heartbeat_interval_ms` integer NOT NULL,
	`heartbeat_timeout_ms` integer NOT NULL,
	`expected_control_mode` text NOT NULL,
	`expected_data_plane_mode` text NOT NULL,
	`degraded_optional_features_json` text NOT NULL,
	`failover_target_id` text,
	`policy_decision_ids_json` text NOT NULL,
	`capacity_snapshot_ref` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`scheduler_epoch` integer NOT NULL
);

--> statement-breakpoint

CREATE TABLE `scheduler_session_leases` (
	`lease_id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`package_snapshot_id` text NOT NULL,
	`pool_id` text NOT NULL,
	`target_id` text NOT NULL,
	`status` text NOT NULL,
	`acquired_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`heartbeat_deadline` text NOT NULL,
	`startup_deadline` text NOT NULL,
	`last_accepted_heartbeat_at` text,
	`last_worker_sequence` integer,
	`renewal_count` integer NOT NULL,
	`scheduler_epoch` integer NOT NULL,
	`sandbox_binding_ref` text NOT NULL,
	`backend_anchor_state` text DEFAULT 'unanchored' NOT NULL,
	`release_reason` text,
	`recovery_state` text,
	`recovery_deadline` text,
	`worker_process_key_hash` text
, `session_compatibility_key` text, `worker_control_token_hash` text, `worker_inference_token_hash` text, `worker_capability_token_hash` text);

--> statement-breakpoint

CREATE TABLE `scheduler_supply_refresh_declarations` (
  `workspace_id` text NOT NULL,
  `thread_id` text NOT NULL,
  `turn_id` text NOT NULL,
  `agent_session_id` text NOT NULL,
  `package_snapshot_id` text NOT NULL,
  `refresh_id` text NOT NULL,
  `sequence` integer NOT NULL,
  `status` text NOT NULL,
  `message` text,
  `acknowledged_at` text NOT NULL,
  PRIMARY KEY(`agent_session_id`, `package_snapshot_id`, `refresh_id`)
);

--> statement-breakpoint

CREATE TABLE `scheduler_target_health_records` (
	`target_id` text PRIMARY KEY NOT NULL,
	`health_state` text NOT NULL,
	`check_results_json` text NOT NULL,
	`consecutive_failure_count` integer NOT NULL,
	`consecutive_success_count` integer NOT NULL,
	`quarantine_entered_at` text,
	`probation_deadline` text,
	`last_probe_at` text NOT NULL,
	`next_probe_at` text NOT NULL
);

--> statement-breakpoint

CREATE TABLE `scheduler_worker_pools` (
	`pool_id` text PRIMARY KEY NOT NULL,
	`allowed_backend_kinds_json` text NOT NULL,
	`allowed_placements_json` text NOT NULL,
	`max_concurrent_sessions` integer NOT NULL,
	`queue_limit` integer NOT NULL,
	`default_timeout_ms` integer NOT NULL,
	`allowed_workspace_scopes_json` text NOT NULL,
	`budget_class` text NOT NULL,
	`health_summary` text NOT NULL,
	`current_admitted_session_count` integer NOT NULL,
	`current_queue_depth` integer NOT NULL,
	`status` text NOT NULL,
	`warm_session_target` integer
);

--> statement-breakpoint

CREATE TABLE `server_settings` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_at` text NOT NULL
);

--> statement-breakpoint

CREATE TABLE `session` (
  `id` text PRIMARY KEY NOT NULL,
  `expires_at` integer NOT NULL,
  `token` text NOT NULL,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `updated_at` integer NOT NULL,
  `ip_address` text,
  `user_agent` text,
  `user_id` text NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  UNIQUE(`token`)
);

--> statement-breakpoint

CREATE TABLE `users` (
  `id` text PRIMARY KEY NOT NULL,
  `display_name` text NOT NULL,
  `email` text NOT NULL,
  `email_verified` integer DEFAULT false NOT NULL,
  `image` text,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `kind` text DEFAULT 'human' NOT NULL,
  `last_seen_at` text, `status` text DEFAULT 'active' NOT NULL
CHECK (`status` IN ('active', 'disabled')), `disabled_at` text,
  UNIQUE(`email`)
);

--> statement-breakpoint

CREATE TABLE `vault_admin_audit_events` (
	`audit_event_id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`actor_kind` text,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`severity` text NOT NULL,
	`summary` text NOT NULL,
	`error_code` text,
	`backend_kind` text NOT NULL,
	`created_at` text NOT NULL
);

--> statement-breakpoint

CREATE TABLE `vault_grants` (
	`grant_id` text PRIMARY KEY NOT NULL,
	`vault_reference_id` text NOT NULL,
	`owner_scope` text NOT NULL,
	`workspace_id` text,
	`user_id` text,
	`subject_summary` text,
	`target_agent_id` text,
	`target_agent_session_id` text,
	`target_capability_id` text,
	`allowed_injection_paths` text NOT NULL,
	`lifetime` text NOT NULL,
	`policy_decision_id` text,
	`approval_id` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text
);

--> statement-breakpoint

CREATE TABLE `vault_injection_plans` (
	`plan_id` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`package_snapshot_id` text,
	`capability_id` text,
	`injection_visibility` text NOT NULL,
	`target_path` text,
	`target_env_var_name` text,
	`expiration_behavior` text NOT NULL,
	`revocation_behavior` text NOT NULL,
	`redaction_rule` text NOT NULL,
	`backend_capability_requirement` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);

--> statement-breakpoint

CREATE TABLE `vault_injection_receipts` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`agent_session_id` text,
	`capability_call_id` text,
	`backend_summary` text NOT NULL,
	`injected_at` text NOT NULL,
	`expires_at` text,
	`revocation_status` text NOT NULL,
	`audit_event_id` text
);

--> statement-breakpoint

CREATE TABLE `vault_references` (
	`reference_id` text PRIMARY KEY NOT NULL,
	`owner_scope` text NOT NULL,
	`workspace_id` text,
	`user_id` text,
	`display_name` text NOT NULL,
	`secret_kind` text NOT NULL,
	`backend_kind` text NOT NULL,
	`backend_locator` text,
	`status` text NOT NULL,
	`current_version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

--> statement-breakpoint

CREATE TABLE `vault_use_records` (
	`use_id` text PRIMARY KEY NOT NULL,
	`owner_scope` text NOT NULL,
	`workspace_id` text,
	`vault_reference_id` text NOT NULL,
	`material_version` integer,
	`backend_kind` text NOT NULL,
	`resolving_path` text NOT NULL,
	`grant_id` text,
	`plan_id` text,
	`receipt_id` text,
	`agent_session_id` text,
	`capability_call_id` text,
	`outcome` text NOT NULL,
	`failure_code` text,
	`audit_event_id` text,
	`used_at` text NOT NULL
);

--> statement-breakpoint

CREATE TABLE `verification` (
  `id` text PRIMARY KEY NOT NULL,
  `identifier` text NOT NULL,
  `value` text NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
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
	`purged_at` text,
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

CREATE TABLE "worker_backend_sessions" (
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
	`origin_physical_epoch` text NOT NULL,
	`backend_lineage_json` text,
	`sandbox_binding_ref` text
);

--> statement-breakpoint

CREATE TABLE `worker_control_commands` (
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`package_snapshot_id` text NOT NULL,
	`request_id` text,
	`command_id` text NOT NULL PRIMARY KEY,
	`command_kind` text NOT NULL,
	`sequence` integer NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`queued_at` text NOT NULL,
	`delivered_at` text,
	`acknowledged_at` text
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
	`accepted_at` text NOT NULL,
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

CREATE TABLE `workspace_invitations` (
  `invitation_id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `invitee_user_id` text NOT NULL,
  `proposed_access_level` text NOT NULL,
  `inviter_user_id` text NOT NULL,
  `status` text NOT NULL,
  `expires_at` text NOT NULL,
  `accepted_at` text,
  `declined_at` text,
  `revoked_at` text,
  `revision` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspace_registry`(`workspace_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`invitee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`inviter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `workspace_invitations_access_check` CHECK (`proposed_access_level` IN ('editor', 'viewer')),
  CONSTRAINT `workspace_invitations_status_check` CHECK (`status` IN ('pending', 'accepted', 'declined', 'revoked')),
  CONSTRAINT `workspace_invitations_revision_check` CHECK (typeof(`revision`) = 'integer' AND `revision` > 0),
  CONSTRAINT `workspace_invitations_terminal_check` CHECK (
    (`status` = 'pending' AND `accepted_at` IS NULL AND `declined_at` IS NULL AND `revoked_at` IS NULL)
    OR (`status` = 'accepted' AND `accepted_at` IS NOT NULL AND `declined_at` IS NULL AND `revoked_at` IS NULL)
    OR (`status` = 'declined' AND `accepted_at` IS NULL AND `declined_at` IS NOT NULL AND `revoked_at` IS NULL)
    OR (`status` = 'revoked' AND `accepted_at` IS NULL AND `declined_at` IS NULL AND `revoked_at` IS NOT NULL)
  )
);

--> statement-breakpoint

CREATE TABLE `workspace_members` (
  `workspace_id` text NOT NULL,
  `user_id` text NOT NULL,
  `status` text NOT NULL,
  `access_level` text NOT NULL,
  `invitation_id` text,
  `joined_at` text NOT NULL,
  `removed_at` text,
  `revision` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`workspace_id`, `user_id`),
  FOREIGN KEY (`workspace_id`) REFERENCES `workspace_registry`(`workspace_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`invitation_id`) REFERENCES `workspace_invitations`(`invitation_id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `workspace_members_status_check` CHECK (`status` IN ('active', 'removed')),
  CONSTRAINT `workspace_members_access_check` CHECK (`access_level` IN ('editor', 'viewer')),
  CONSTRAINT `workspace_members_revision_check` CHECK (typeof(`revision`) = 'integer' AND `revision` > 0),
  CONSTRAINT `workspace_members_lifecycle_check` CHECK (
    (`status` = 'active' AND `removed_at` IS NULL)
    OR (`status` = 'removed' AND `removed_at` IS NOT NULL)
  )
);

--> statement-breakpoint

CREATE TABLE `workspace_registry` (
  `workspace_id` text PRIMARY KEY NOT NULL,
  `owner_user_id` text NOT NULL,
  `status` text NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `workspace_registry_status_check` CHECK (`status` IN ('active', 'deleting', 'deleted')),
  CONSTRAINT `workspace_registry_revision_check` CHECK (typeof(`revision`) = 'integer' AND `revision` > 0)
);

--> statement-breakpoint

CREATE INDEX `account_userId_idx` ON `account` (`user_id`);

--> statement-breakpoint

CREATE UNIQUE INDEX `agent_session_runtime_bindings_current_thread_idx`
ON `agent_session_runtime_bindings` (`workspace_id`,`thread_id`)
WHERE `lifecycle_state` NOT IN ('closed','failed');

--> statement-breakpoint

CREATE INDEX `agent_session_runtime_bindings_harness_idx` ON `agent_session_runtime_bindings` (`harness_instance_id`,`lifecycle_state`);

--> statement-breakpoint

CREATE UNIQUE INDEX `agent_session_runtime_bindings_session_idx` ON `agent_session_runtime_bindings` (`agent_session_id`);

--> statement-breakpoint

CREATE INDEX `audit_events_capability_call_idx` ON `audit_events` (`capability_call_id`);

--> statement-breakpoint

CREATE INDEX `audit_events_permission_decision_idx` ON `audit_events` (`permission_decision_id`);

--> statement-breakpoint

CREATE INDEX `audit_events_request_idx` ON `audit_events` (`request_id`);

--> statement-breakpoint

CREATE INDEX `audit_events_vault_grant_idx` ON `audit_events` (`vault_grant_id`);

--> statement-breakpoint

CREATE INDEX `audit_events_workspace_idx` ON `audit_events` (`workspace_id`,`category`,`created_at`);

--> statement-breakpoint

CREATE INDEX `boot_audit_events_boot_idx` ON `boot_audit_events` (`boot_id`,`created_at`);

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

CREATE UNIQUE INDEX `openkit_access_tokens_hash_idx` ON `openkit_access_tokens` (`token_hash`);

--> statement-breakpoint

CREATE INDEX `openkit_access_tokens_owner_idx` ON `openkit_access_tokens` (`owner_user_id`,`status`);

--> statement-breakpoint

CREATE INDEX `permission_decisions_enforcement_idx` ON `permission_decisions` (`enforcement_point`,`created_at`);

--> statement-breakpoint

CREATE INDEX `permission_decisions_owner_idx` ON `permission_decisions` (`owner_scope`,`workspace_id`,`created_at`);

--> statement-breakpoint

CREATE UNIQUE INDEX `sandbox_runtime_records_binding_idx` ON `sandbox_runtime_records` (`sandbox_binding_ref`);

--> statement-breakpoint

CREATE UNIQUE INDEX `sandbox_runtime_records_integration_binding_idx` ON `sandbox_runtime_records` (`sandbox_integration_binding_ref`);

--> statement-breakpoint

CREATE INDEX `sandbox_runtime_records_target_idx` ON `sandbox_runtime_records` (`runtime_target_id`,`lifecycle_state`);

--> statement-breakpoint

CREATE UNIQUE INDEX `scheduler_admission_entries_non_terminal_turn_idx` ON `scheduler_admission_entries` (`turn_id`) WHERE `status` IN ('queued','admitted');

--> statement-breakpoint

CREATE INDEX `scheduler_admission_entries_queue_idx` ON `scheduler_admission_entries` (`status`,`priority_class`,`effective_priority_at`,`enqueued_at`);

--> statement-breakpoint

CREATE INDEX `scheduler_admission_entries_workspace_idx` ON `scheduler_admission_entries` (`workspace_id`,`status`,`enqueued_at`);

--> statement-breakpoint

CREATE INDEX `scheduler_capacity_records_pool_idx` ON `scheduler_capacity_records` (`pool_id`,`observed_at`);

--> statement-breakpoint

CREATE UNIQUE INDEX `scheduler_orphan_worker_evidence_lease_idx` ON `scheduler_orphan_worker_evidence` (`lease_id`,`reason`,`scheduler_epoch`);

--> statement-breakpoint

CREATE INDEX `scheduler_orphan_worker_evidence_scope_idx` ON `scheduler_orphan_worker_evidence` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`,`reason`);

--> statement-breakpoint

CREATE INDEX `scheduler_placement_plans_lineage_idx` ON `scheduler_placement_plans` (`workspace_id`,`thread_id`,`turn_id`);

--> statement-breakpoint

CREATE INDEX `scheduler_placement_plans_queue_idx` ON `scheduler_placement_plans` (`queue_entry_id`,`status`);

--> statement-breakpoint

CREATE INDEX `scheduler_placement_plans_target_idx` ON `scheduler_placement_plans` (`selected_pool_id`,`selected_target_id`,`status`);

--> statement-breakpoint

CREATE UNIQUE INDEX `scheduler_session_leases_binding_idx` ON `scheduler_session_leases` (`sandbox_binding_ref`);

--> statement-breakpoint

CREATE INDEX `scheduler_session_leases_deadline_idx` ON `scheduler_session_leases` (`status`,`expires_at`,`heartbeat_deadline`);

--> statement-breakpoint

CREATE INDEX `scheduler_session_leases_lineage_idx` ON `scheduler_session_leases` (`workspace_id`,`thread_id`,`turn_id`);

--> statement-breakpoint

CREATE INDEX `scheduler_session_leases_plan_idx` ON `scheduler_session_leases` (`plan_id`,`status`);

--> statement-breakpoint

CREATE INDEX `scheduler_session_leases_recovery_idx` ON `scheduler_session_leases` (`recovery_state`,`recovery_deadline`);

--> statement-breakpoint

CREATE INDEX `scheduler_session_leases_target_idx` ON `scheduler_session_leases` (`pool_id`,`target_id`,`status`);

--> statement-breakpoint

CREATE INDEX `scheduler_supply_refresh_declarations_scope_idx` ON `scheduler_supply_refresh_declarations` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`,`status`);

--> statement-breakpoint

CREATE INDEX `scheduler_target_health_records_state_idx` ON `scheduler_target_health_records` (`health_state`,`next_probe_at`);

--> statement-breakpoint

CREATE INDEX `scheduler_worker_pools_status_idx` ON `scheduler_worker_pools` (`status`,`budget_class`);

--> statement-breakpoint

CREATE INDEX `session_userId_idx` ON `session` (`user_id`);

--> statement-breakpoint

CREATE INDEX `vault_admin_audit_events_action_idx` ON `vault_admin_audit_events` (`action`,`outcome`,`created_at`);

--> statement-breakpoint

CREATE INDEX `vault_admin_audit_events_actor_idx` ON `vault_admin_audit_events` (`actor_user_id`,`created_at`);

--> statement-breakpoint

CREATE INDEX `vault_grants_lifetime_idx` ON `vault_grants` (`lifetime`,`status`);

--> statement-breakpoint

CREATE INDEX `vault_grants_owner_idx` ON `vault_grants` (`owner_scope`,`workspace_id`,`user_id`,`status`);

--> statement-breakpoint

CREATE INDEX `vault_grants_reference_idx` ON `vault_grants` (`vault_reference_id`,`status`);

--> statement-breakpoint

CREATE INDEX `vault_injection_plans_capability_idx` ON `vault_injection_plans` (`capability_id`,`status`);

--> statement-breakpoint

CREATE INDEX `vault_injection_plans_grant_idx` ON `vault_injection_plans` (`grant_id`,`status`);

--> statement-breakpoint

CREATE INDEX `vault_injection_receipts_grant_idx` ON `vault_injection_receipts` (`grant_id`,`revocation_status`);

--> statement-breakpoint

CREATE INDEX `vault_injection_receipts_plan_idx` ON `vault_injection_receipts` (`plan_id`,`revocation_status`);

--> statement-breakpoint

CREATE INDEX `vault_injection_receipts_session_idx` ON `vault_injection_receipts` (`agent_session_id`,`revocation_status`);

--> statement-breakpoint

CREATE INDEX `vault_references_backend_idx` ON `vault_references` (`backend_kind`,`status`);

--> statement-breakpoint

CREATE INDEX `vault_references_owner_idx` ON `vault_references` (`owner_scope`,`workspace_id`,`user_id`,`status`);

--> statement-breakpoint

CREATE INDEX `vault_use_records_actor_idx` ON `vault_use_records` (`agent_session_id`,`capability_call_id`);

--> statement-breakpoint

CREATE INDEX `vault_use_records_owner_idx` ON `vault_use_records` (`owner_scope`,`workspace_id`,`outcome`);

--> statement-breakpoint

CREATE INDEX `vault_use_records_reference_idx` ON `vault_use_records` (`vault_reference_id`,`material_version`,`outcome`);

--> statement-breakpoint

CREATE INDEX `vault_use_records_resolution_idx` ON `vault_use_records` (`grant_id`,`plan_id`,`receipt_id`);

--> statement-breakpoint

CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);

--> statement-breakpoint

CREATE UNIQUE INDEX `worker_backend_sessions_backend_session_idx` ON `worker_backend_sessions` (`backend_session_id`);

--> statement-breakpoint

CREATE UNIQUE INDEX `worker_backend_sessions_endpoint_provider_idx` ON `worker_backend_sessions` (`backend_kind`,`gateway_endpoint`,`transient_provider_instance_id`) WHERE `gateway_endpoint` IS NOT NULL AND `transient_provider_instance_id` IS NOT NULL;

--> statement-breakpoint

CREATE UNIQUE INDEX `worker_backend_sessions_endpoint_target_idx` ON `worker_backend_sessions` (`backend_kind`,`gateway_endpoint`,`backend_session_id`) WHERE `gateway_endpoint` IS NOT NULL;

--> statement-breakpoint

CREATE INDEX `worker_backend_sessions_lineage_idx` ON `worker_backend_sessions` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`);

--> statement-breakpoint

CREATE UNIQUE INDEX `worker_backend_sessions_named_provider_idx` ON `worker_backend_sessions` (`backend_kind`,`gateway_name`,`transient_provider_instance_id`) WHERE `gateway_endpoint` IS NULL AND `transient_provider_instance_id` IS NOT NULL;

--> statement-breakpoint

CREATE UNIQUE INDEX `worker_backend_sessions_named_target_idx` ON `worker_backend_sessions` (`backend_kind`,`gateway_name`,`backend_session_id`) WHERE `gateway_endpoint` IS NULL;

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

CREATE UNIQUE INDEX `worker_storage_bindings_current_sandbox_idx` ON `worker_storage_bindings` (`current_sandbox_binding_ref`);

--> statement-breakpoint

CREATE INDEX `worker_storage_bindings_target_idx` ON `worker_storage_bindings` (`runtime_target_id`,`state`);

--> statement-breakpoint

CREATE INDEX `worker_storage_bindings_workspace_idx` ON `worker_storage_bindings` (`workspace_id`,`state`);

--> statement-breakpoint

CREATE INDEX `worker_storage_contributors_audience_idx` ON `worker_storage_contributors` (`workspace_id`,`responsible_user_id`,`thread_id`);

--> statement-breakpoint

CREATE INDEX `worker_storage_contributors_slot_idx` ON `worker_storage_contributors` (`storage_ref`,`work_slot_ref`);

--> statement-breakpoint

CREATE INDEX `worker_storage_contributors_generation_idx` ON `worker_storage_contributors` (`storage_ref`,`attachment_generation`);

--> statement-breakpoint

CREATE INDEX `worker_control_commands_scope_idx` ON `worker_control_commands` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`,`status`,`sequence`);

--> statement-breakpoint

CREATE INDEX `worker_control_records_scope_idx` ON `worker_control_records` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`,`operation`,`record_key`);

--> statement-breakpoint

CREATE INDEX `worker_control_rejected_evidence_scope_idx` ON `worker_control_rejected_evidence` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`,`operation`,`error_code`);

--> statement-breakpoint

CREATE INDEX `worker_control_sequence_fingerprints_scope_idx` ON `worker_control_sequence_fingerprints` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`,`operation`,`sequence`);

--> statement-breakpoint

CREATE INDEX `workspace_invitations_invitee_idx` ON `workspace_invitations` (`invitee_user_id`, `status`, `expires_at`);

--> statement-breakpoint

CREATE UNIQUE INDEX `workspace_invitations_pending_idx`
  ON `workspace_invitations` (`workspace_id`, `invitee_user_id`)
  WHERE `status` = 'pending';

--> statement-breakpoint

CREATE INDEX `workspace_invitations_workspace_idx` ON `workspace_invitations` (`workspace_id`, `status`, `created_at`);

--> statement-breakpoint

CREATE INDEX `workspace_members_user_id_idx` ON `workspace_members` (`user_id`, `status`, `workspace_id`);

--> statement-breakpoint

CREATE INDEX `workspace_registry_owner_user_id_idx` ON `workspace_registry` (`owner_user_id`);

--> statement-breakpoint

CREATE TRIGGER `workspace_owner_member_delete_guard`
BEFORE DELETE ON `workspace_members`
WHEN EXISTS (
  SELECT 1
  FROM `workspace_registry`
  WHERE `workspace_id` = OLD.`workspace_id`
    AND `owner_user_id` = OLD.`user_id`
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_owner_membership_required');
END;

--> statement-breakpoint

CREATE TRIGGER `workspace_owner_member_update_guard`
BEFORE UPDATE OF `workspace_id`, `user_id`, `status`, `access_level` ON `workspace_members`
WHEN EXISTS (
  SELECT 1
  FROM `workspace_registry`
  WHERE `workspace_id` = OLD.`workspace_id`
    AND `owner_user_id` = OLD.`user_id`
)
AND (
  NEW.`workspace_id` <> OLD.`workspace_id`
  OR NEW.`user_id` <> OLD.`user_id`
  OR NEW.`status` <> 'active'
  OR NEW.`access_level` <> 'editor'
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_owner_membership_required');
END;

--> statement-breakpoint

CREATE TRIGGER `workspace_owner_transfer_guard`
BEFORE UPDATE OF `owner_user_id` ON `workspace_registry`
WHEN NOT EXISTS (
  SELECT 1
  FROM `workspace_members`
  WHERE `workspace_id` = OLD.`workspace_id`
    AND `user_id` = NEW.`owner_user_id`
    AND `status` = 'active'
    AND `access_level` = 'editor'
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_owner_membership_required');
END;
