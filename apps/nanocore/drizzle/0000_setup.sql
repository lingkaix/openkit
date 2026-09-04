-- openkit:scope core

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

CREATE TABLE `nanohost_integration_identities` (
	`identity_id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`decommissioned_at` text
);

CREATE TABLE `nanohost_runtime_targets` (
	`target_id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`deployment_id` text NOT NULL,
	`connection_generation` integer NOT NULL,
	`predecessor_fenced` integer NOT NULL,
	`ready` integer NOT NULL,
	`fresh_empty` integer NOT NULL,
	`observed_at` text NOT NULL,
	`slot_count` integer NOT NULL, `last_fresh_ready_at` text);

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

CREATE TABLE `sandbox_runtime_records` (
	`sandbox_runtime_id` text PRIMARY KEY NOT NULL,
	`runtime_target_id` text NOT NULL REFERENCES `nanohost_runtime_targets`(`target_id`) ON DELETE RESTRICT,
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

CREATE TABLE `schema_migrations` (
  `id` text PRIMARY KEY NOT NULL,
  `applied_at` text NOT NULL
);

CREATE TABLE `server_settings` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_at` text NOT NULL
);

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

CREATE TABLE `verification` (
  `id` text PRIMARY KEY NOT NULL,
  `identifier` text NOT NULL,
  `value` text NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);

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
	`backend_lineage_json` text,
	`sandbox_binding_ref` text
);

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

CREATE INDEX `account_userId_idx` ON `account` (`user_id`);

CREATE UNIQUE INDEX `agent_session_runtime_bindings_current_thread_idx`
ON `agent_session_runtime_bindings` (`workspace_id`,`thread_id`)
WHERE `lifecycle_state` NOT IN ('closed','failed');

CREATE INDEX `agent_session_runtime_bindings_harness_idx` ON `agent_session_runtime_bindings` (`harness_instance_id`,`lifecycle_state`);

CREATE UNIQUE INDEX `agent_session_runtime_bindings_session_idx` ON `agent_session_runtime_bindings` (`agent_session_id`);

CREATE INDEX `audit_events_capability_call_idx` ON `audit_events` (`capability_call_id`);

CREATE INDEX `audit_events_permission_decision_idx` ON `audit_events` (`permission_decision_id`);

CREATE INDEX `audit_events_request_idx` ON `audit_events` (`request_id`);

CREATE INDEX `audit_events_vault_grant_idx` ON `audit_events` (`vault_grant_id`);

CREATE INDEX `audit_events_workspace_idx` ON `audit_events` (`workspace_id`,`category`,`created_at`);

CREATE INDEX `boot_audit_events_boot_idx` ON `boot_audit_events` (`boot_id`,`created_at`);

CREATE UNIQUE INDEX `harness_instance_records_binding_idx` ON `harness_instance_records` (`harness_binding_ref`);

CREATE UNIQUE INDEX `harness_instance_records_compatibility_idx` ON `harness_instance_records` (`sandbox_runtime_id`,`harness_compatibility_key`);

CREATE UNIQUE INDEX `nanohost_integration_identities_deployment_idx` ON `nanohost_integration_identities` (`deployment_id`);

CREATE UNIQUE INDEX `nanohost_transport_tokens_hash_idx` ON `nanohost_transport_tokens` (`token_hash`);

CREATE INDEX `nanohost_transport_tokens_owner_idx` ON `nanohost_transport_tokens` (`owner_nanohost_identity_id`,`deployment_id`,`status`);

CREATE UNIQUE INDEX `openkit_access_tokens_hash_idx` ON `openkit_access_tokens` (`token_hash`);

CREATE INDEX `openkit_access_tokens_owner_idx` ON `openkit_access_tokens` (`owner_user_id`,`status`);

CREATE INDEX `permission_decisions_enforcement_idx` ON `permission_decisions` (`enforcement_point`,`created_at`);

CREATE INDEX `permission_decisions_owner_idx` ON `permission_decisions` (`owner_scope`,`workspace_id`,`created_at`);

CREATE UNIQUE INDEX `sandbox_runtime_records_binding_idx` ON `sandbox_runtime_records` (`sandbox_binding_ref`);

CREATE UNIQUE INDEX `sandbox_runtime_records_integration_binding_idx` ON `sandbox_runtime_records` (`sandbox_integration_binding_ref`);

CREATE INDEX `sandbox_runtime_records_target_idx` ON `sandbox_runtime_records` (`runtime_target_id`,`lifecycle_state`);

CREATE UNIQUE INDEX `scheduler_admission_entries_non_terminal_turn_idx` ON `scheduler_admission_entries` (`turn_id`) WHERE `status` IN ('queued','admitted');

CREATE INDEX `scheduler_admission_entries_queue_idx` ON `scheduler_admission_entries` (`status`,`priority_class`,`effective_priority_at`,`enqueued_at`);

CREATE INDEX `scheduler_admission_entries_workspace_idx` ON `scheduler_admission_entries` (`workspace_id`,`status`,`enqueued_at`);

CREATE INDEX `scheduler_capacity_records_pool_idx` ON `scheduler_capacity_records` (`pool_id`,`observed_at`);

CREATE UNIQUE INDEX `scheduler_orphan_worker_evidence_lease_idx` ON `scheduler_orphan_worker_evidence` (`lease_id`,`reason`,`scheduler_epoch`);

CREATE INDEX `scheduler_orphan_worker_evidence_scope_idx` ON `scheduler_orphan_worker_evidence` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`,`reason`);

CREATE INDEX `scheduler_placement_plans_lineage_idx` ON `scheduler_placement_plans` (`workspace_id`,`thread_id`,`turn_id`);

CREATE INDEX `scheduler_placement_plans_queue_idx` ON `scheduler_placement_plans` (`queue_entry_id`,`status`);

CREATE INDEX `scheduler_placement_plans_target_idx` ON `scheduler_placement_plans` (`selected_pool_id`,`selected_target_id`,`status`);

CREATE UNIQUE INDEX `scheduler_session_leases_binding_idx` ON `scheduler_session_leases` (`sandbox_binding_ref`);

CREATE INDEX `scheduler_session_leases_deadline_idx` ON `scheduler_session_leases` (`status`,`expires_at`,`heartbeat_deadline`);

CREATE INDEX `scheduler_session_leases_lineage_idx` ON `scheduler_session_leases` (`workspace_id`,`thread_id`,`turn_id`);

CREATE INDEX `scheduler_session_leases_plan_idx` ON `scheduler_session_leases` (`plan_id`,`status`);

CREATE INDEX `scheduler_session_leases_recovery_idx` ON `scheduler_session_leases` (`recovery_state`,`recovery_deadline`);

CREATE INDEX `scheduler_session_leases_target_idx` ON `scheduler_session_leases` (`pool_id`,`target_id`,`status`);

CREATE INDEX `scheduler_supply_refresh_declarations_scope_idx` ON `scheduler_supply_refresh_declarations` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`,`status`);

CREATE INDEX `scheduler_target_health_records_state_idx` ON `scheduler_target_health_records` (`health_state`,`next_probe_at`);

CREATE INDEX `scheduler_worker_pools_status_idx` ON `scheduler_worker_pools` (`status`,`budget_class`);

CREATE INDEX `session_userId_idx` ON `session` (`user_id`);

CREATE INDEX `vault_admin_audit_events_action_idx` ON `vault_admin_audit_events` (`action`,`outcome`,`created_at`);

CREATE INDEX `vault_admin_audit_events_actor_idx` ON `vault_admin_audit_events` (`actor_user_id`,`created_at`);

CREATE INDEX `vault_grants_lifetime_idx` ON `vault_grants` (`lifetime`,`status`);

CREATE INDEX `vault_grants_owner_idx` ON `vault_grants` (`owner_scope`,`workspace_id`,`user_id`,`status`);

CREATE INDEX `vault_grants_reference_idx` ON `vault_grants` (`vault_reference_id`,`status`);

CREATE INDEX `vault_injection_plans_capability_idx` ON `vault_injection_plans` (`capability_id`,`status`);

CREATE INDEX `vault_injection_plans_grant_idx` ON `vault_injection_plans` (`grant_id`,`status`);

CREATE INDEX `vault_injection_receipts_grant_idx` ON `vault_injection_receipts` (`grant_id`,`revocation_status`);

CREATE INDEX `vault_injection_receipts_plan_idx` ON `vault_injection_receipts` (`plan_id`,`revocation_status`);

CREATE INDEX `vault_injection_receipts_session_idx` ON `vault_injection_receipts` (`agent_session_id`,`revocation_status`);

CREATE INDEX `vault_references_backend_idx` ON `vault_references` (`backend_kind`,`status`);

CREATE INDEX `vault_references_owner_idx` ON `vault_references` (`owner_scope`,`workspace_id`,`user_id`,`status`);

CREATE INDEX `vault_use_records_actor_idx` ON `vault_use_records` (`agent_session_id`,`capability_call_id`);

CREATE INDEX `vault_use_records_owner_idx` ON `vault_use_records` (`owner_scope`,`workspace_id`,`outcome`);

CREATE INDEX `vault_use_records_reference_idx` ON `vault_use_records` (`vault_reference_id`,`material_version`,`outcome`);

CREATE INDEX `vault_use_records_resolution_idx` ON `vault_use_records` (`grant_id`,`plan_id`,`receipt_id`);

CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);

CREATE UNIQUE INDEX `worker_backend_sessions_backend_session_idx` ON `worker_backend_sessions` (`backend_session_id`);

CREATE UNIQUE INDEX `worker_backend_sessions_endpoint_provider_idx` ON `worker_backend_sessions` (`backend_kind`,`gateway_endpoint`,`transient_provider_instance_id`) WHERE `gateway_endpoint` IS NOT NULL AND `transient_provider_instance_id` IS NOT NULL;

CREATE UNIQUE INDEX `worker_backend_sessions_endpoint_target_idx` ON `worker_backend_sessions` (`backend_kind`,`gateway_endpoint`,`backend_session_id`) WHERE `gateway_endpoint` IS NOT NULL;

CREATE INDEX `worker_backend_sessions_lineage_idx` ON `worker_backend_sessions` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`);

CREATE UNIQUE INDEX `worker_backend_sessions_named_provider_idx` ON `worker_backend_sessions` (`backend_kind`,`gateway_name`,`transient_provider_instance_id`) WHERE `gateway_endpoint` IS NULL AND `transient_provider_instance_id` IS NOT NULL;

CREATE UNIQUE INDEX `worker_backend_sessions_named_target_idx` ON `worker_backend_sessions` (`backend_kind`,`gateway_name`,`backend_session_id`) WHERE `gateway_endpoint` IS NULL;

CREATE UNIQUE INDEX `worker_backend_sessions_package_idx` ON `worker_backend_sessions` (`package_snapshot_id`);

CREATE UNIQUE INDEX `worker_backend_sessions_sandbox_binding_idx` ON `worker_backend_sessions` (`sandbox_binding_ref`) WHERE `sandbox_binding_ref` IS NOT NULL;

CREATE UNIQUE INDEX `worker_backend_sessions_staging_idx` ON `worker_backend_sessions` (`staging_directory_ref`);

CREATE INDEX `worker_backend_sessions_state_idx` ON `worker_backend_sessions` (`state`,`updated_at`);

CREATE UNIQUE INDEX `worker_backend_sessions_transient_provider_idx` ON `worker_backend_sessions` (`transient_provider_instance_id`) WHERE `transient_provider_instance_id` IS NOT NULL;

CREATE INDEX `worker_control_commands_scope_idx` ON `worker_control_commands` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`,`status`,`sequence`);

CREATE INDEX `worker_control_records_scope_idx` ON `worker_control_records` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`,`operation`,`record_key`);

CREATE INDEX `worker_control_rejected_evidence_scope_idx` ON `worker_control_rejected_evidence` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`,`operation`,`error_code`);

CREATE INDEX `worker_control_sequence_fingerprints_scope_idx` ON `worker_control_sequence_fingerprints` (`workspace_id`,`thread_id`,`turn_id`,`agent_session_id`,`package_snapshot_id`,`operation`,`sequence`);

CREATE INDEX `workspace_invitations_invitee_idx` ON `workspace_invitations` (`invitee_user_id`, `status`, `expires_at`);

CREATE UNIQUE INDEX `workspace_invitations_pending_idx`
  ON `workspace_invitations` (`workspace_id`, `invitee_user_id`)
  WHERE `status` = 'pending';

CREATE INDEX `workspace_invitations_workspace_idx` ON `workspace_invitations` (`workspace_id`, `status`, `created_at`);

CREATE INDEX `workspace_members_user_id_idx` ON `workspace_members` (`user_id`, `status`, `workspace_id`);

CREATE INDEX `workspace_registry_owner_user_id_idx` ON `workspace_registry` (`owner_user_id`);

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

-- openkit:scope user

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

CREATE TABLE `schema_migrations` (
  `id` text PRIMARY KEY NOT NULL,
  `applied_at` text NOT NULL
);

-- openkit:scope workspace

CREATE TABLE `artifact_reviews` (
	`workspace_id` text NOT NULL,
	`review_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`artifact_version` integer NOT NULL,
	`content_digest` text NOT NULL,
	`source_thread_id` text,
	`source_turn_id` text,
	`source_agent_id` text,
	`proposal_material_id` text,
	`proposal_base_revision_id` text,
	`proposal_base_content_digest` text,
	`decision` text,
	`decision_actor_id` text,
	`decision_request_id` text,
	`feedback` text,
	`decided_at` text,
	`follow_up_turn_id` text,
	`applied_material_revision_id` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`artifact_id`,`artifact_version`),
	CONSTRAINT `artifact_reviews_review_id_check` CHECK (length(`review_id`) = 29 AND substr(`review_id`, 1, 5) = 'arev_' AND substr(`review_id`, 6) NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT `artifact_reviews_version_check` CHECK (typeof(`artifact_version`) = 'integer' AND `artifact_version` > 0),
	CONSTRAINT `artifact_reviews_content_digest_check` CHECK (length(`content_digest`) = 71 AND substr(`content_digest`, 1, 7) = 'sha256:' AND substr(`content_digest`, 8) NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT `artifact_reviews_proposal_tuple_check` CHECK ((`proposal_material_id` IS NULL AND `proposal_base_revision_id` IS NULL AND `proposal_base_content_digest` IS NULL) OR (`proposal_material_id` IS NOT NULL AND `proposal_base_revision_id` IS NOT NULL AND `proposal_base_content_digest` IS NOT NULL)),
	CONSTRAINT `artifact_reviews_proposal_digest_check` CHECK (`proposal_base_content_digest` IS NULL OR (length(`proposal_base_content_digest`) = 71 AND substr(`proposal_base_content_digest`, 1, 7) = 'sha256:' AND substr(`proposal_base_content_digest`, 8) NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT `artifact_reviews_feedback_check` CHECK (`feedback` IS NULL OR length(`feedback`) > 0),
	CONSTRAINT `artifact_reviews_decision_check` CHECK (
		(
			`decision` IS NULL
			AND `decision_actor_id` IS NULL
			AND `decision_request_id` IS NULL
			AND `feedback` IS NULL
			AND `decided_at` IS NULL
			AND `follow_up_turn_id` IS NULL
			AND `applied_material_revision_id` IS NULL
		) OR (
			`decision` IN ('accepted', 'needs_refinement', 'redo', 'rejected', 'deferred')
			AND `decision_actor_id` IS NOT NULL
			AND `decision_request_id` IS NOT NULL
			AND length(`decision_request_id`) > 0
			AND `decided_at` IS NOT NULL
			AND (
				(`decision` IN ('needs_refinement', 'redo') AND `feedback` IS NOT NULL AND `follow_up_turn_id` IS NOT NULL AND `applied_material_revision_id` IS NULL)
				OR (`decision` = 'accepted' AND `follow_up_turn_id` IS NULL AND ((`proposal_material_id` IS NULL AND `applied_material_revision_id` IS NULL) OR (`proposal_material_id` IS NOT NULL AND `applied_material_revision_id` IS NOT NULL)))
				OR (`decision` IN ('rejected', 'deferred') AND `follow_up_turn_id` IS NULL AND `applied_material_revision_id` IS NULL)
			)
		)
	)
);

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

CREATE TABLE `backend_workspace_handles` (
	`backend_workspace_handle_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`materialization_record_id` text NOT NULL,
	`backend_kind` text NOT NULL,
	`package_snapshot_id` text NOT NULL,
	`worker_session_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`backend_workspace_handle_id`)
);

CREATE TABLE `capability_calls` (
	`call_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text,
	`turn_id` text,
	`item_id` text,
	`agent_id` text,
	`agent_session_id` text,
	`request_id` text,
	`source_ids_json` text NOT NULL DEFAULT '[]',
	`capability_id` text NOT NULL,
	`family` text NOT NULL,
	`operation` text NOT NULL,
	`status` text NOT NULL,
	`summary` text,
	`provider_ref` text,
	`service_ref` text,
	`redaction_class` text NOT NULL,
	`error_code` text,
	`started_at` text,
	`completed_at` text
, `package_snapshot_id` text, `schema_snapshot_id` text, `runtime_origin_ref` text, `runtime_cache_lineage_ref` text);

CREATE TABLE `evidence_bundles` (
  `evidence_bundle_id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `thread_id` text,
  `goal_id` text,
  `turn_id` text,
  `agent_session_id` text,
  `backend_type` text,
  `source_kind` text NOT NULL,
  `summary` text NOT NULL,
  `raw_evidence_refs_json` text NOT NULL,
  `redacted_evidence_refs_json` text NOT NULL,
  `content_digests_json` text NOT NULL,
  `retention_class` text NOT NULL,
  `sensitivity_class` text NOT NULL,
  `import_status` text NOT NULL,
  `required_features_json` text NOT NULL,
  `created_at` text NOT NULL
);

CREATE TABLE `git_push_records` (
	`push_record_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`repository_resource_id` text NOT NULL,
	`approval_row_id` text,
	`policy_decision_id` text,
	`actor_id` text,
	`remote_summary` text NOT NULL,
	`source_ref` text NOT NULL,
	`target_branch` text NOT NULL,
	`commit_ids_json` text NOT NULL,
	`review_ids_json` text NOT NULL,
	`remote_head_before` text,
	`remote_head_after` text,
	`outcome` text NOT NULL,
	`error_summary` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`request_id` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`push_record_id`)
);

CREATE TABLE `goal_plan_records` (
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`plan_item_id` text NOT NULL,
	`plan_digest` text NOT NULL,
	`plan_json` text NOT NULL,
	`created_by_request_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`thread_id`,`plan_item_id`)
);

CREATE TABLE `goal_records` (
	`goal_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`objective` text NOT NULL,
	`created_by_item_id` text,
	`plan_item_id` text,
	`current_task_id` text,
	`terminal_stop_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`thread_id`,`goal_id`)
);

CREATE TABLE `goal_review_records` (
	`review_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`task_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`item_ids_json` text NOT NULL,
	`artifact_ids_json` text NOT NULL,
	`verification_evidence_json` text NOT NULL,
	`prompt` text NOT NULL,
	`created_by_request_id` text NOT NULL,
	`verdict` text,
	`reason` text,
	`revision_instruction` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`resolved_at` text,
	`resolution_request_id` text,
	`resolved_by_actor_id` text, `resolution_snapshot_json` text,
	PRIMARY KEY(`workspace_id`,`thread_id`,`goal_id`,`review_id`)
);

CREATE TABLE `goal_tasks` (
	`task_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`plan_item_id` text NOT NULL,
	`status` text NOT NULL,
	`latest_gate_context_item_id` text,
	`title` text NOT NULL,
	`objective` text NOT NULL,
	`order_index` integer NOT NULL,
	`depends_on_task_ids_json` text NOT NULL,
	`acceptance_criteria_json` text NOT NULL,
	`context_budget_tokens` integer NOT NULL,
	`resources_json` text NOT NULL,
	`expected_artifacts_json` text NOT NULL,
	`verification_checks_json` text NOT NULL,
	`review_policy_json` text NOT NULL,
	`escalation_conditions_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`thread_id`,`goal_id`,`task_id`)
);

CREATE TABLE `goal_verification_records` (
	`verification_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`task_id` text,
	`turn_id` text,
	`command_id` text,
	`command` text,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`item_ids_json` text NOT NULL,
	`artifact_ids_json` text NOT NULL,
	`output_pointers_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`thread_id`,`goal_id`,`verification_id`)
);

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

CREATE TABLE `mcp_tool_schema_snapshots` (
	`snapshot_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`catalog_entry_id` text NOT NULL,
	`source_ref` text,
	`server_version` text,
	`content_digest` text NOT NULL,
	`tools_json` text NOT NULL,
	`source` text NOT NULL,
	`captured_at` text NOT NULL
);

CREATE TABLE `pending_user_turn_records` (
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`pending_turn_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`active_turn_id` text NOT NULL,
	`request_id` text NOT NULL,
	`content_item_id` text NOT NULL,
	`input_kind` text NOT NULL,
	`material_id` text,
	`revision_id` text,
	`content_digest` text,
	`queue_mode` text NOT NULL,
	`received_at` text NOT NULL,
	`terminal_claim_kind` text,
	`terminal_claim_id` text,
	`terminal_claimed_at` text,
	PRIMARY KEY(`workspace_id`,`thread_id`),
	CONSTRAINT `pending_user_turn_records_input_kind_check` CHECK (`input_kind` IN ('message', 'material')),
	CONSTRAINT `pending_user_turn_records_input_tuple_check` CHECK ((`input_kind` = 'message' AND `material_id` IS NULL AND `revision_id` IS NULL AND `content_digest` IS NULL) OR (`input_kind` = 'material' AND `material_id` IS NOT NULL AND `revision_id` IS NOT NULL AND `content_digest` IS NOT NULL)),
	CONSTRAINT `pending_user_turn_records_digest_check` CHECK (`content_digest` IS NULL OR (length(`content_digest`) = 71 AND substr(`content_digest`, 1, 7) = 'sha256:' AND substr(`content_digest`, 8) NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT `pending_user_turn_records_queue_mode_check` CHECK (`queue_mode` = 'safe_point_steering'),
	CONSTRAINT `pending_user_turn_records_claim_check` CHECK ((`terminal_claim_kind` IS NULL AND `terminal_claim_id` IS NULL AND `terminal_claimed_at` IS NULL) OR (`terminal_claim_kind` IS NOT NULL AND `terminal_claim_kind` IN ('applied', 'follow-up', 'cancelled') AND `terminal_claim_id` IS NOT NULL AND `terminal_claimed_at` IS NOT NULL))
);

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

CREATE TABLE `resolved_agent_setups` (
	`setup_record_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`turn_id` text,
	`request_id` text,
	`agent_id` text NOT NULL,
	`logical_model_id` text NOT NULL,
	`runtime_kind` text NOT NULL,
	`runtime_adapter` text NOT NULL,
	`required_features_json` text NOT NULL,
	`setup_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`setup_record_id`)
);

CREATE TABLE `runtime_evidence` (
  `runtime_evidence_id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `thread_id` text,
  `turn_id` text,
  `goal_id` text,
  `task_id` text,
  `agent_session_id` text,
  `backend_type` text,
  `backend_version` text,
  `placement` text NOT NULL,
  `phase` text NOT NULL,
  `summary` text NOT NULL,
  `policy_digest` text,
  `worker_image` text,
  `sandbox_summary` text,
  `capability_summary` text,
  `upload_manifest_json` text NOT NULL,
  `download_manifest_json` text NOT NULL,
  `transcript_summary` text,
  `workspace_change_summary` text,
  `control_summary` text,
  `outcome` text NOT NULL,
  `exit_code` integer,
  `signal` text,
  `stop_reason` text,
  `error_code` text,
  `error_message` text,
  `redacted_stdout_summary` text,
  `redacted_stderr_summary` text,
  `evidence_bundle_ids_json` text NOT NULL,
  `content_digests_json` text NOT NULL,
  `required_features_json` text NOT NULL,
  `created_at` text NOT NULL,
  `started_at` text,
  `completed_at` text,
  `collected_at` text
);

CREATE TABLE `schema_migrations` (
  `id` text PRIMARY KEY NOT NULL,
  `applied_at` text NOT NULL
);

CREATE TABLE `staged_workspace_reviews` (
	`review_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`change_set_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`status` text NOT NULL,
	`payload_json` text NOT NULL,
	`patch_payload_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`review_id`)
);

CREATE TABLE `steering_terminal_outcomes` (
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`pending_turn_id` text NOT NULL,
	`outcome_id` text NOT NULL,
	`state` text NOT NULL,
	`send_request_id` text NOT NULL,
	`terminal_request_id` text NOT NULL,
	`content_item_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`active_turn_id` text NOT NULL,
	`input_kind` text NOT NULL,
	`material_id` text,
	`revision_id` text,
	`content_digest` text,
	`follow_up_turn_id` text,
	`follow_up_item_id` text,
	`accepted_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`thread_id`,`pending_turn_id`),
	CONSTRAINT `steering_terminal_outcomes_state_check` CHECK (`state` IN ('follow-up', 'cancelled')),
	CONSTRAINT `steering_terminal_outcomes_input_kind_check` CHECK (`input_kind` IN ('message', 'material')),
	CONSTRAINT `steering_terminal_outcomes_input_tuple_check` CHECK ((`input_kind` = 'message' AND `material_id` IS NULL AND `revision_id` IS NULL AND `content_digest` IS NULL) OR (`input_kind` = 'material' AND `material_id` IS NOT NULL AND `revision_id` IS NOT NULL AND `content_digest` IS NOT NULL)),
	CONSTRAINT `steering_terminal_outcomes_digest_check` CHECK (`content_digest` IS NULL OR (length(`content_digest`) = 71 AND substr(`content_digest`, 1, 7) = 'sha256:' AND substr(`content_digest`, 8) NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT `steering_terminal_outcomes_follow_up_check` CHECK ((`state` = 'follow-up' AND `follow_up_turn_id` IS NOT NULL AND `follow_up_item_id` IS NOT NULL) OR (`state` = 'cancelled' AND `follow_up_turn_id` IS NULL AND `follow_up_item_id` IS NULL))
);

CREATE TABLE `thread_material_bindings` (
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`material_id` text NOT NULL,
	`binding_state` text NOT NULL,
	`latest_queued_revision_id` text,
	`inclusion_state` text NOT NULL,
	`last_mutation_request_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`thread_id`,`material_id`),
	CONSTRAINT `thread_material_bindings_state_check` CHECK (`binding_state` IN ('bound', 'unbound')),
	CONSTRAINT `thread_material_bindings_inclusion_check` CHECK (`inclusion_state` IN ('included', 'excluded')),
	CONSTRAINT `thread_material_bindings_unbound_check` CHECK (`binding_state` = 'bound' OR (`latest_queued_revision_id` IS NULL AND `inclusion_state` = 'included')),
	CONSTRAINT `thread_material_bindings_excluded_check` CHECK (`inclusion_state` = 'included' OR (`binding_state` = 'bound' AND `latest_queued_revision_id` IS NOT NULL))
);

CREATE TABLE `usage_records` (
	`usage_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text,
	`turn_id` text,
	`item_id` text,
	`capability_call_id` text,
	`request_id` text,
	`agent_id` text,
	`agent_session_id` text,
	`source_ids_json` text NOT NULL DEFAULT '[]',
	`category` text NOT NULL,
	`unit` text NOT NULL,
	`quantity` real NOT NULL,
	`model_id` text,
	`provider_ref` text,
	`source` text,
	`recorded_at` text NOT NULL
, `responsible_user_id` text);

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

CREATE TABLE `worker_output_manifests` (
	`worker_output_manifest_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`materialization_record_id` text NOT NULL,
	`input_snapshot_id` text NOT NULL,
	`worker_session_id` text NOT NULL,
	`backend_kind` text NOT NULL,
	`strategy` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`worker_output_manifest_id`)
);

CREATE TABLE `worker_turn_checkpoints` (
	`checkpoint_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`goal_id` text,
	`task_id` text,
	`request_id` text NOT NULL,
	`request_input_hash` text NOT NULL,
	`stage` text NOT NULL,
	`iteration` integer NOT NULL,
	`worker_session_id` text,
	`context_digest` text,
	`stop_reason` text,
	`diagnostics_summary` text,
	`replay_instruction` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE TABLE `workspace_apply_plans` (
	`apply_plan_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`review_id` text NOT NULL,
	`change_set_id` text NOT NULL,
	`strategy` text NOT NULL,
	`approval_state` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`apply_plan_id`)
);

CREATE TABLE `workspace_apply_results` (
	`apply_result_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`review_id` text NOT NULL,
	`change_set_id` text NOT NULL,
	`status` text NOT NULL,
	`applied_paths_json` text NOT NULL,
	`skipped_paths_json` text NOT NULL,
	`conflict_records_json` text NOT NULL,
	`verification_json` text NOT NULL,
	`commit_ids_json` text NOT NULL,
	`applied_at` text NOT NULL,
	`request_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`apply_result_id`)
);

CREATE TABLE `workspace_change_sets` (
	`change_set_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`input_snapshot_id` text NOT NULL,
	`materialization_record_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`strategy` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`change_set_id`)
);

CREATE TABLE `workspace_filesystem_staging_roots` (
	`workspace_id` text NOT NULL,
	`review_id` text NOT NULL,
	`change_set_id` text NOT NULL,
	`staging_root_path` text NOT NULL,
	`target_root_path` text NOT NULL,
	`before_manifest_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `review_id`)
);

CREATE TABLE `workspace_input_snapshots` (
	`input_snapshot_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`strategy` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`input_snapshot_id`)
);

CREATE TABLE `workspace_material_revisions` (
	`workspace_id` text NOT NULL,
	`material_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`parent_revision_id` text,
	`media_type` text NOT NULL,
	`content_digest` text NOT NULL,
	`content` text NOT NULL,
	`author_id` text NOT NULL,
	`created_by_request_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`material_id`,`revision_id`),
	CONSTRAINT `workspace_material_revisions_media_type_check` CHECK (`media_type` IN ('text/markdown', 'text/plain')),
	CONSTRAINT `workspace_material_revisions_digest_check` CHECK (length(`content_digest`) = 71 AND substr(`content_digest`, 1, 7) = 'sha256:' AND substr(`content_digest`, 8) NOT GLOB '*[^0-9a-f]*')
);

CREATE TABLE `workspace_materialization_records` (
	`materialization_record_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`input_snapshot_id` text NOT NULL,
	`package_snapshot_id` text NOT NULL,
	`worker_session_id` text NOT NULL,
	`strategy` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`materialization_record_id`)
);

CREATE TABLE `workspace_materials` (
	`workspace_id` text NOT NULL,
	`material_id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`current_revision_id` text,
	`sensitivity` text NOT NULL,
	`last_mutation_request_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`material_id`),
	CONSTRAINT `workspace_materials_kind_check` CHECK (`kind` IN ('markdown', 'text')),
	CONSTRAINT `workspace_materials_sensitivity_check` CHECK (`sensitivity` IN ('public', 'internal', 'restricted'))
);

CREATE TABLE workspace_quarantine_records (
  quarantine_record_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  failure_kind TEXT NOT NULL,
  resolution TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (workspace_id, quarantine_record_id)
);

CREATE TABLE `workspace_reconciliation_records` (
	`reconciliation_record_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`trigger_reason` text NOT NULL,
	`state_after` text NOT NULL,
	`payload_json` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`reconciliation_record_id`)
);

CREATE TABLE `workspace_repository_resources` (
  `workspace_id` text NOT NULL,
  `resource_id` text NOT NULL,
  `type` text NOT NULL,
  `display_name` text NOT NULL,
  `local_path` text NOT NULL,
  `diagnostics_status` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL, `commit_on_apply` integer NOT NULL DEFAULT 0, `git_author_name` text, `git_author_email` text, `staging_strategy` text NOT NULL DEFAULT 'staging-root', `protected_branch_patterns_json` text NOT NULL DEFAULT '["main","master","release/*","v*"]', `allowed_push_targets_json` text NOT NULL DEFAULT '[]', `require_review_linkage` integer NOT NULL DEFAULT 1, `git_push_vault_grant_ref` text,
  PRIMARY KEY(`workspace_id`, `resource_id`)
);

CREATE UNIQUE INDEX `artifact_reviews_identity_idx` ON `artifact_reviews` (`workspace_id`,`review_id`);

CREATE INDEX `audit_events_capability_call_idx` ON `audit_events` (`capability_call_id`);

CREATE INDEX `audit_events_permission_decision_idx` ON `audit_events` (`permission_decision_id`);

CREATE INDEX `audit_events_request_idx` ON `audit_events` (`request_id`);

CREATE INDEX `audit_events_vault_grant_idx` ON `audit_events` (`vault_grant_id`);

CREATE INDEX `audit_events_workspace_idx` ON `audit_events` (`workspace_id`,`category`,`created_at`);

CREATE INDEX `backend_workspace_handles_materialization_idx` ON `backend_workspace_handles` (`workspace_id`,`materialization_record_id`,`created_at`,`backend_workspace_handle_id`);

CREATE INDEX `backend_workspace_handles_package_idx` ON `backend_workspace_handles` (`workspace_id`,`package_snapshot_id`,`created_at`,`backend_workspace_handle_id`);

CREATE UNIQUE INDEX `capability_calls_idempotency_idx` ON `capability_calls` (`workspace_id`,`request_id`,`family`,`operation`);

CREATE INDEX `capability_calls_workspace_idx` ON `capability_calls` (`workspace_id`,`status`,`started_at`);

CREATE INDEX `evidence_bundles_goal_idx` ON `evidence_bundles` (`workspace_id`, `goal_id`);

CREATE INDEX `evidence_bundles_status_idx` ON `evidence_bundles` (`import_status`, `retention_class`);

CREATE INDEX `evidence_bundles_thread_idx` ON `evidence_bundles` (`workspace_id`, `thread_id`, `turn_id`);

CREATE INDEX `evidence_bundles_workspace_idx` ON `evidence_bundles` (`workspace_id`, `created_at`);

CREATE INDEX `git_push_records_repository_idx` ON `git_push_records` (`workspace_id`,`repository_resource_id`,`created_at`,`push_record_id`);

CREATE INDEX `goal_plan_records_goal_idx` ON `goal_plan_records` (`workspace_id`,`thread_id`,`goal_id`,`created_at`,`plan_item_id`);

CREATE INDEX `goal_records_thread_idx` ON `goal_records` (`workspace_id`,`thread_id`,`updated_at`,`goal_id`);

CREATE INDEX `goal_review_records_task_idx` ON `goal_review_records` (`workspace_id`,`thread_id`,`goal_id`,`task_id`,`created_at`,`review_id`);

CREATE INDEX `goal_tasks_goal_order_idx` ON `goal_tasks` (`workspace_id`,`thread_id`,`goal_id`,`order_index`,`task_id`);

CREATE INDEX `goal_verification_records_goal_idx` ON `goal_verification_records` (`workspace_id`,`thread_id`,`goal_id`,`created_at`,`verification_id`);

CREATE INDEX `goal_verification_records_task_idx` ON `goal_verification_records` (`workspace_id`,`thread_id`,`goal_id`,`task_id`,`created_at`,`verification_id`);

CREATE INDEX idx_workspace_quarantine_records_workspace_resolution_created
  ON workspace_quarantine_records (workspace_id, resolution, created_at, quarantine_record_id);

CREATE UNIQUE INDEX `mcp_tool_schema_snapshots_digest_idx` ON `mcp_tool_schema_snapshots` (`workspace_id`,`catalog_entry_id`,`source`,`content_digest`);

CREATE INDEX `mcp_tool_schema_snapshots_workspace_idx` ON `mcp_tool_schema_snapshots` (`workspace_id`,`catalog_entry_id`,`captured_at`);

CREATE UNIQUE INDEX `pending_user_turn_records_identity_idx` ON `pending_user_turn_records` (`workspace_id`,`pending_turn_id`);

CREATE INDEX `permission_decisions_enforcement_idx` ON `permission_decisions` (`enforcement_point`,`created_at`);

CREATE INDEX `permission_decisions_owner_idx` ON `permission_decisions` (`owner_scope`,`workspace_id`,`created_at`);

CREATE UNIQUE INDEX `permission_decisions_terminal_approval_idx`
ON `permission_decisions` (`approval_id`)
WHERE `owner_scope` = 'workspace'
  AND `approval_id` IS NOT NULL
  AND `result` IN ('allow', 'deny');

CREATE INDEX `resolved_agent_setups_agent_idx` ON `resolved_agent_setups` (`workspace_id`,`agent_id`,`created_at`);

CREATE INDEX `resolved_agent_setups_turn_idx` ON `resolved_agent_setups` (`workspace_id`,`turn_id`);

CREATE INDEX `runtime_evidence_agent_session_idx` ON `runtime_evidence` (`workspace_id`, `agent_session_id`);

CREATE INDEX `runtime_evidence_phase_idx` ON `runtime_evidence` (`phase`, `outcome`);

CREATE INDEX `runtime_evidence_thread_idx` ON `runtime_evidence` (`workspace_id`, `thread_id`, `turn_id`);

CREATE INDEX `runtime_evidence_workspace_idx` ON `runtime_evidence` (`workspace_id`, `created_at`);

CREATE INDEX `staged_workspace_reviews_change_set_idx` ON `staged_workspace_reviews` (`workspace_id`,`change_set_id`,`updated_at`,`review_id`);

CREATE UNIQUE INDEX `steering_terminal_outcomes_identity_idx` ON `steering_terminal_outcomes` (`workspace_id`,`outcome_id`);

CREATE UNIQUE INDEX `steering_terminal_outcomes_terminal_request_idx` ON `steering_terminal_outcomes` (`workspace_id`,`thread_id`,`terminal_request_id`);

CREATE UNIQUE INDEX `thread_material_bindings_bound_thread_idx` ON `thread_material_bindings` (`workspace_id`,`thread_id`) WHERE `binding_state` = 'bound';

CREATE INDEX `thread_material_bindings_material_queue_idx` ON `thread_material_bindings` (`workspace_id`,`material_id`,`binding_state`,`thread_id`);

CREATE INDEX `usage_records_capability_call_idx` ON `usage_records` (`capability_call_id`);

CREATE INDEX `usage_records_workspace_idx` ON `usage_records` (`workspace_id`,`category`,`recorded_at`);

CREATE INDEX `vault_use_records_actor_idx` ON `vault_use_records` (`agent_session_id`,`capability_call_id`);

CREATE INDEX `vault_use_records_owner_idx` ON `vault_use_records` (`owner_scope`,`workspace_id`,`outcome`);

CREATE INDEX `vault_use_records_reference_idx` ON `vault_use_records` (`vault_reference_id`,`material_version`,`outcome`);

CREATE INDEX `vault_use_records_resolution_idx` ON `vault_use_records` (`grant_id`,`plan_id`,`receipt_id`);

CREATE INDEX `worker_output_manifests_materialization_idx` ON `worker_output_manifests` (`workspace_id`,`materialization_record_id`,`created_at`,`worker_output_manifest_id`);

CREATE INDEX `worker_turn_checkpoints_scope_idx` ON `worker_turn_checkpoints` (`workspace_id`,`thread_id`,`turn_id`);

CREATE INDEX `worker_turn_checkpoints_updated_idx` ON `worker_turn_checkpoints` (`updated_at`);

CREATE INDEX `workspace_apply_plans_review_idx` ON `workspace_apply_plans` (`workspace_id`,`review_id`,`created_at`,`apply_plan_id`);

CREATE INDEX `workspace_apply_results_review_idx` ON `workspace_apply_results` (`workspace_id`,`review_id`,`applied_at`,`apply_result_id`);

CREATE INDEX `workspace_change_sets_materialization_idx` ON `workspace_change_sets` (`workspace_id`,`materialization_record_id`,`created_at`,`change_set_id`);

CREATE INDEX `workspace_filesystem_staging_change_set_idx` ON `workspace_filesystem_staging_roots` (`workspace_id`,`change_set_id`,`updated_at`,`review_id`);

CREATE INDEX `workspace_input_snapshots_resource_idx` ON `workspace_input_snapshots` (`workspace_id`,`resource_id`,`created_at`,`input_snapshot_id`);

CREATE UNIQUE INDEX `workspace_material_revisions_child_idx` ON `workspace_material_revisions` (`workspace_id`,`material_id`,`parent_revision_id`) WHERE `parent_revision_id` IS NOT NULL;

CREATE INDEX `workspace_material_revisions_list_idx` ON `workspace_material_revisions` (`workspace_id`,`material_id`,`created_at`,`revision_id`);

CREATE UNIQUE INDEX `workspace_material_revisions_root_idx` ON `workspace_material_revisions` (`workspace_id`,`material_id`) WHERE `parent_revision_id` IS NULL;

CREATE INDEX `workspace_materialization_records_input_idx` ON `workspace_materialization_records` (`workspace_id`,`input_snapshot_id`,`created_at`,`materialization_record_id`);

CREATE INDEX `workspace_materialization_records_package_idx` ON `workspace_materialization_records` (`workspace_id`,`package_snapshot_id`,`created_at`,`materialization_record_id`);

CREATE INDEX `workspace_materials_list_idx` ON `workspace_materials` (`workspace_id`,`created_at`,`material_id`);

CREATE INDEX `workspace_reconciliation_records_state_idx` ON `workspace_reconciliation_records` (`workspace_id`,`state_after`,`started_at`,`reconciliation_record_id`);
