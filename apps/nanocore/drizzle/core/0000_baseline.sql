-- Pre-v0.1.0 fresh baseline. Edit this file directly before the first stable release.
-- This initializes an empty scope; it does not upgrade a predecessor database.
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
CHECK (`resource_revision` IS NULL OR (typeof(`resource_revision`) = 'integer' AND `resource_revision` > 0)), `notebook_admission_json` text, `schema_version` integer NOT NULL, `policy_invocation_json` text, `policy_write_outcome_json` text, `authentication_json` text);
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
, `schema_version` integer DEFAULT 1 NOT NULL);
--> statement-breakpoint
CREATE TABLE `capability_calls` (
	`call_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text CHECK (`workspace_id` IS NULL),
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
, `package_snapshot_id` text, `schema_snapshot_id` text, `runtime_origin_ref` text, `runtime_cache_lineage_ref` text, `system_prompt_digest` text,
	`extensions_json` text, `schema_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `capability_calls_system_prompt_digest_check` CHECK (`system_prompt_digest` IS NULL OR (`family` = 'llm' AND `capability_id` IN ('llm.chat_completions', 'llm.responses')))
);
--> statement-breakpoint
CREATE TABLE `control_execution_steps` (
  `execution_id` text NOT NULL REFERENCES `control_executions` (`id`),
  `step_id` text NOT NULL CHECK (length(`step_id`) > 0),
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `ordinal` integer NOT NULL CHECK (typeof(`ordinal`) = 'integer' AND `ordinal` BETWEEN 1 AND 9007199254740991),
  `parent_step_id` text CHECK (`parent_step_id` IS NULL OR `parent_step_id` <> `step_id`),
  `state` text NOT NULL CHECK (`state` IN ('intent', 'completed', 'failed', 'unknown', 'cancelled')),
  `invocation_id` text NOT NULL CHECK (length(`invocation_id`) > 0),
  `control_json` text NOT NULL CHECK (COALESCE(json_valid(`control_json`) AND json_type(`control_json`) = 'object' AND json_type(`control_json`, '$.definitionVersion') = 'text' AND json_extract(`control_json`, '$.kind') IN ('admit', 'queue-capacity-wait', 'reserve', 'resolve-setup', 'validate-setup', 'materialize', 'open-session', 'inspect-session', 'deliver-start', 'observe', 'collect', 'terminal-publication', 'cancel', 'human-wait', 'consume-receipt', 'inspect-cleanup', 'fence', 'release') AND json_type(`control_json`, '$.workId') = 'text' AND json_extract(`control_json`, '$.invocationId') = `invocation_id` AND json_type(`control_json`, '$.actor') = 'object' AND json_type(`control_json`, '$.inputRefs') = 'array' AND json_type(`control_json`, '$.outputRefs') = 'array' AND json_type(`control_json`, '$.authorityRefs') = 'array' AND json_type(`control_json`, '$.physicalFenceRefs') = 'array' AND json_type(`control_json`, '$.retryPermitted') IN ('true', 'false') AND json_type(`control_json`, '$.deadlineUnixNano') IN ('text', 'null') AND json_type(`control_json`, '$.target') IN ('object', 'null'), 0)),
  `invocation_json` text NOT NULL CHECK (COALESCE(json_valid(`invocation_json`) AND json_type(`invocation_json`) = 'object' AND json_type(`invocation_json`, '$.parent') IN ('object', 'null') AND json_type(`invocation_json`, '$.carriage') = 'object' AND json_type(`invocation_json`, '$.clock') = 'object' AND json_type(`invocation_json`, '$.clock.processWitness') = 'text' AND json_type(`invocation_json`, '$.clock.admittedUnixNano') = 'text' AND json_type(`invocation_json`, '$.clock.admittedMonotonicNano') = 'text' AND json_type(`invocation_json`, '$.remainingMs') IS NULL, 0)),
  `span_json` text NOT NULL CHECK (COALESCE(json_valid(`span_json`) AND json_type(`span_json`) = 'object' AND json_type(`span_json`, '$.startTimeUnixNano') = 'text' AND json_type(`span_json`, '$.endTimeUnixNano') IN ('text', 'null'), 0)),
  `inspected_execution_id` text,
  `inspected_step_id` text,
  PRIMARY KEY (`execution_id`, `step_id`),
  FOREIGN KEY (`execution_id`, `parent_step_id`) REFERENCES `control_execution_steps` (`execution_id`, `step_id`),
  FOREIGN KEY (`inspected_execution_id`, `inspected_step_id`) REFERENCES `control_execution_steps` (`execution_id`, `step_id`),
  CHECK ((`inspected_execution_id` IS NULL) = (`inspected_step_id` IS NULL)),
  CHECK (`inspected_execution_id` IS NULL OR `inspected_execution_id` <> `execution_id` OR `inspected_step_id` <> `step_id`),
  CHECK (COALESCE((`state` = 'intent' AND json_type(`span_json`, '$.endTimeUnixNano') = 'null') OR (`state` <> 'intent' AND json_type(`span_json`, '$.endTimeUnixNano') = 'text'), 0)),
  CHECK (`state` <> 'unknown' OR COALESCE(json_extract(`span_json`, '$.status.code') = 'ERROR', 0))
);
--> statement-breakpoint
CREATE TABLE `control_executions` (
  `id` text PRIMARY KEY NOT NULL CHECK (length(`id`) > 0),
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `owner_json` text NOT NULL CHECK (COALESCE(json_valid(`owner_json`) AND json_type(`owner_json`) = 'object' AND json_extract(`owner_json`, '$.kind') = 'server' AND json_type(`owner_json`, '$.workspaceId') IS NULL AND json_type(`owner_json`, '$.userId') IS NULL, 0)),
  `work_id` text NOT NULL CHECK (length(`work_id`) > 0),
  `definition_version` text NOT NULL CHECK (length(`definition_version`) > 0),
  `input_fingerprint` text NOT NULL CHECK (length(`input_fingerprint`) > 0),
  `phase` text NOT NULL CHECK (`phase` IN ('open', 'closing', 'closed')),
  `revision` integer NOT NULL CHECK (typeof(`revision`) = 'integer' AND `revision` BETWEEN 1 AND 9007199254740991),
  `terminal_cause` text,
  `exclusion_refs_json` text NOT NULL CHECK (COALESCE(json_valid(`exclusion_refs_json`) AND json_type(`exclusion_refs_json`) = 'array', 0)),
  `span_json` text NOT NULL CHECK (COALESCE(json_valid(`span_json`) AND json_type(`span_json`) = 'object' AND json_type(`span_json`, '$.startTimeUnixNano') = 'text' AND json_type(`span_json`, '$.endTimeUnixNano') IN ('text', 'null'), 0))
);
--> statement-breakpoint
CREATE TABLE `control_product_entries` (
  `kind` text NOT NULL CHECK (`kind` IN ('item', 'event')),
  `turn_id` text NOT NULL REFERENCES `control_turns` (`id`),
  `sequence` integer NOT NULL CHECK (`sequence` > 0),
  `id` text NOT NULL,
  `revision` integer NOT NULL CHECK (`revision` > 0),
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `content_json` text NOT NULL CHECK (json_valid(`content_json`)),
  `identity_json` text NOT NULL CHECK (json_valid(`identity_json`)), `read_metadata_json` text, `is_current` integer NOT NULL DEFAULT 0, `turn_admission_order` integer NOT NULL DEFAULT 0, `item_order` integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`kind`, `turn_id`, `sequence`)
);
--> statement-breakpoint
CREATE TABLE `control_threads` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text CHECK (`workspace_id` IS NULL),
  `status` text NOT NULL CHECK (`status` IN ('active', 'archived')),
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `revision` integer NOT NULL CHECK (`revision` > 0),
  `record_json` text NOT NULL CHECK (json_valid(`record_json`))
);
--> statement-breakpoint
CREATE TABLE `control_turns` (
  `id` text PRIMARY KEY NOT NULL,
  `thread_id` text NOT NULL REFERENCES `control_threads` (`id`),
  `agent_session_id` text CHECK (`agent_session_id` IS NULL),
  `status` text NOT NULL CHECK (`status` IN ('pending', 'running', 'completed', 'interrupted', 'cancelled', 'failed')),
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `revision` integer NOT NULL CHECK (`revision` > 0),
  `record_json` text NOT NULL CHECK (json_valid(`record_json`))
, `admission_order` integer NOT NULL DEFAULT 0 CHECK (`admission_order` >= 0 AND `admission_order` <= 9007199254740991), `thread_read_order` integer NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE TABLE `control_work_observations` (
  `turn_id` text NOT NULL REFERENCES `control_turns` (`id`),
  `sequence` integer NOT NULL CHECK (`sequence` > 0),
  `id` text NOT NULL,
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `record_json` text NOT NULL CHECK (json_valid(`record_json`)),
  PRIMARY KEY (`turn_id`, `sequence`),
  UNIQUE (`turn_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE discord_account_bindings (
  discord_user_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  revoked_at INTEGER
);
--> statement-breakpoint
CREATE TABLE discord_disclosures (
  token_digest TEXT PRIMARY KEY NOT NULL,
  discord_user_id TEXT NOT NULL,
  binding_revision TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  pending_request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('approval','user-input')),
  content_digest TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE discord_inbound_receipts (
  event_id TEXT PRIMARY KEY NOT NULL,
  payload_digest TEXT NOT NULL,
  request_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('dispatching','settled','response-unknown')),
  created_at INTEGER NOT NULL
, discord_user_id TEXT, core_user_id TEXT, binding_revision TEXT, operation_id TEXT CHECK (operation_id IN ('approval.respond', 'question.answer')), workspace_id TEXT, thread_id TEXT, pending_request_id TEXT, turn_id TEXT);
--> statement-breakpoint
CREATE TABLE discord_pairing_challenges (
  digest TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
--> statement-breakpoint
CREATE TABLE `evidence_bundles` (
  `evidence_bundle_id` text PRIMARY KEY NOT NULL,
  `workspace_id` text CHECK (`workspace_id` IS NULL),
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
, `schema_version` integer DEFAULT 1 NOT NULL);
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
  `expires_at` text,
  `schema_version` integer DEFAULT 1 NOT NULL,
  CHECK ((command_name = 'scheduler.external-trigger.admit' AND expires_at IS NULL)
    OR (command_name <> 'scheduler.external-trigger.admit' AND expires_at IS NOT NULL))
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
CREATE TABLE notification_attention (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('approval-request', 'user-input-request', 'security-notice')),
  request_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  channel TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, thread_id, source_kind, request_id, recipient_user_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX notification_security_notice ON notification_attention(request_id) WHERE source_kind = 'security-notice';
--> statement-breakpoint
CREATE TABLE notification_delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attention_id TEXT NOT NULL REFERENCES notification_attention(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed-no-send', 'delivery-unknown')),
  failure_code TEXT CHECK (failure_code IN ('authority-unavailable', 'transport-refused', 'transport-unknown', 'restart')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK ((status = 'sending' AND finished_at IS NULL AND failure_code IS NULL)
    OR (status = 'sent' AND finished_at IS NOT NULL AND failure_code IS NULL)
    OR (status = 'failed-no-send' AND finished_at IS NOT NULL AND failure_code IN ('authority-unavailable', 'transport-refused'))
    OR (status = 'delivery-unknown' AND finished_at IS NOT NULL AND failure_code IN ('transport-unknown', 'restart')))
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
	`last_used_source` text, `schema_version` integer DEFAULT 1 NOT NULL, `issuer_ref_json` text, `principal_ref_json` text, `run_subject_json` text,
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
, `schema_version` integer NOT NULL, `mediation_json` text);
--> statement-breakpoint
CREATE TABLE recurring_expired_ranges (
  id TEXT PRIMARY KEY NOT NULL,
  schedule_id TEXT NOT NULL REFERENCES recurring_schedules(id),
  workspace_id TEXT NOT NULL,
  definition_revision INTEGER NOT NULL,
  first_scheduled_at INTEGER NOT NULL,
  last_scheduled_at INTEGER NOT NULL,
  record_json TEXT NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
  UNIQUE(schedule_id, first_scheduled_at)
);
--> statement-breakpoint
CREATE TABLE recurring_occurrences (
  id TEXT PRIMARY KEY NOT NULL,
  schedule_id TEXT NOT NULL REFERENCES recurring_schedules(id),
  workspace_id TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'admission-accepted', 'admission-failed', 'expired', 'cancelled', 'recovery_required')),
  queue_entry_id TEXT UNIQUE,
  record_json TEXT NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
  UNIQUE(schedule_id, scheduled_at)
);
--> statement-breakpoint
CREATE TABLE recurring_schedules (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  responsible_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('paused', 'active', 'deleted')),
  revision INTEGER NOT NULL,
  next_scheduled_at INTEGER,
  record_json TEXT NOT NULL
, `schema_version` integer DEFAULT 1 NOT NULL);
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
CREATE TABLE `scheduler_admission_entries` (
	`backend_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`queue_entry_id` text PRIMARY KEY NOT NULL,
	`request_id` text,
	`trigger_actor_json` text NOT NULL,
	`server_admin_token_id` text,
	`credential_ref_json` text,
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
	`reasoning_effort` text,
	`enqueued_at` text NOT NULL,
	`status` text NOT NULL,
	`denial_reason` text
, `schema_version` integer DEFAULT 1 NOT NULL);
--> statement-breakpoint
CREATE TABLE `scheduler_execution_attempts` (
  `attempt_id` text PRIMARY KEY NOT NULL,
  `queue_entry_id` text NOT NULL,
  `backend_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `thread_id` text NOT NULL,
  `turn_id` text NOT NULL,
  `agent_session_id` text,
  `preparation_input_json` text NOT NULL,
  `input_ref` text,
  `binding_ref` text,
  `phase` text NOT NULL CHECK (`phase` IN ('open','closing','closed')),
  `disposition` text NOT NULL CHECK (`disposition` IN ('not_accepted','accepted','unknown')),
  `operation_id` text,
  `deadline` text,
  `terminal_cause` text,
  `outcome_ref` text,
  `fence_ref` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `session_compatibility_key` text,
  `heartbeat_timeout_ms` integer NOT NULL DEFAULT 30000,
  `heartbeat_deadline` text,
  `startup_deadline` text,
  `last_accepted_heartbeat_at` text,
  `last_worker_sequence` integer,
  `recovery_state` text,
  `recovery_deadline` text,
  `worker_process_key_hash` text,
  `worker_control_token_hash` text,
  `worker_inference_token_hash` text,
  `worker_capability_token_hash` text
, `schema_version` integer DEFAULT 1 NOT NULL);
--> statement-breakpoint
CREATE TABLE `security_thread_destinations` (
  `schema_version` integer DEFAULT 1 NOT NULL,
  `recipient_user_id` text NOT NULL,
  `generation` integer NOT NULL CHECK (`generation` BETWEEN 1 AND 9007199254740991),
  `workspace_id` text NOT NULL,
  `thread_id` text NOT NULL,
  `source_request_id` text NOT NULL REFERENCES `security_trigger_outbox` (`request_id`),
  `status` text NOT NULL CHECK (`status` IN ('reserved','ready')),
  `created_at` text NOT NULL,
  PRIMARY KEY (`recipient_user_id`, `generation`)
);
--> statement-breakpoint
CREATE TABLE `security_trigger_alarms` (
  `id` text PRIMARY KEY NOT NULL,
  `schema_version` integer DEFAULT 1 NOT NULL,
  `enable_generation` integer NOT NULL CHECK (`enable_generation` BETWEEN 1 AND 9007199254740991),
  `rule` text NOT NULL CHECK (`rule` IN ('R1','R8')),
  `recipient_count` integer NOT NULL CHECK (`recipient_count` >= 0),
  `failure` text CHECK (`failure` IS NULL OR `failure` = 'no-current-administrator'),
  `created_at` text NOT NULL,
  CHECK ((`recipient_count` = 0 AND `failure` IS NOT NULL AND `failure` = 'no-current-administrator') OR (`recipient_count` > 0 AND `failure` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `security_trigger_audit_progress` (
  `singleton` integer PRIMARY KEY NOT NULL CHECK (`singleton` = 1),
  `schema_version` integer DEFAULT 1 NOT NULL,
  `cursor_rowid` integer,
  `cursor_created_at` text,
  `cursor_audit_event_id` text,
  `assessed_count` integer DEFAULT 0 NOT NULL CHECK (`assessed_count` BETWEEN 0 AND 9007199254740991),
  CHECK ((`cursor_rowid` IS NULL AND `cursor_created_at` IS NULL AND `cursor_audit_event_id` IS NULL)
    OR (`cursor_rowid` IS NOT NULL AND `cursor_rowid` BETWEEN 1 AND 9007199254740991 AND `cursor_created_at` IS NOT NULL AND `cursor_audit_event_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `security_trigger_audit_assessments` (
  `audit_event_id` text PRIMARY KEY NOT NULL,
  `schema_version` integer DEFAULT 1 NOT NULL,
  `source_rowid` integer NOT NULL CHECK (`source_rowid` BETWEEN 1 AND 9007199254740991),
  `created_at` text NOT NULL,
  `enable_generation` integer NOT NULL CHECK (`enable_generation` > 0),
  `action` text NOT NULL,
  `actor_json` text,
  `target_user_id` text,
  `outcome` text NOT NULL CHECK (`outcome` IN ('succeeded','failed','denied','cancelled','unknown')),
  `responsible_user_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('detected','unsupported')),
  `rule` text CHECK (`rule` IN ('R1','R1d','E12')),
  `notify` text CHECK (`notify` IN ('immediate','daily')),
  `missing_fields_json` text NOT NULL,
  `recipient_count` integer NOT NULL CHECK (`recipient_count` BETWEEN 0 AND 9007199254740991),
  CHECK ((`status` = 'unsupported' AND `rule` IS NULL AND `notify` IS NULL AND `recipient_count` = 0)
    OR (`status` = 'detected' AND `rule` IS NOT NULL AND `notify` IS NOT NULL AND (`recipient_count` > 0 OR `rule` = 'E12'))),
  CHECK (`rule` IS NULL OR `rule` <> 'R1d' OR `recipient_count` = 1)
);
--> statement-breakpoint
CREATE TABLE `security_trigger_outbox` (
  `request_id` text PRIMARY KEY NOT NULL,
  `schema_version` integer DEFAULT 1 NOT NULL,
  `alarm_id` text REFERENCES `security_trigger_alarms` (`id`),
  `audit_event_id` text REFERENCES `security_trigger_audit_assessments` (`audit_event_id`),
  `key_json` text NOT NULL,
  `recipient_user_id` text NOT NULL,
  `occurrence_kind` text NOT NULL CHECK (`occurrence_kind` IN ('initial','reopen','reminder','renotice','conflict')),
  `occurrence_n` integer NOT NULL CHECK (`occurrence_n` BETWEEN 1 AND 9007199254740991),
  `raised` integer DEFAULT 0 NOT NULL CHECK (`raised` IN (0,1)),
  `attention_id` text REFERENCES notification_attention(id),
  `created_at` text NOT NULL,
  CHECK ((`raised` = 0 AND `attention_id` IS NULL) OR (`raised` = 1 AND `attention_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `security_trigger_state` (
  `singleton` integer PRIMARY KEY NOT NULL CHECK (`singleton` = 1),
  `schema_version` integer DEFAULT 1 NOT NULL,
  `state` text DEFAULT 'off' NOT NULL CHECK (`state` IN ('off','on','stopping')),
  `enable_generation` integer DEFAULT 0 NOT NULL CHECK (`enable_generation` BETWEEN 0 AND 9007199254740991),
  `enabling_user_id` text,
  `expected_alarm_count` integer DEFAULT 0 NOT NULL CHECK (`expected_alarm_count` BETWEEN 0 AND 2),
  CHECK (`state` = 'off' OR (`enabling_user_id` IS NOT NULL AND `enable_generation` > 0)),
  CHECK (`state` != 'on' OR `expected_alarm_count` = 0),
  CHECK (`state` != 'stopping' OR `expected_alarm_count` > 0)
);
--> statement-breakpoint
CREATE TABLE `server_settings` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_at` text NOT NULL
, `schema_version` integer DEFAULT 1 NOT NULL);
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
CREATE TABLE `usage_records` (
	`usage_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text CHECK (`workspace_id` IS NULL),
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
, `responsible_user_id` text, `schema_version` integer DEFAULT 1 NOT NULL, `provider_model` text);
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
CHECK (`status` IN ('active', 'disabled')), `disabled_at` text, `personal_workspace_id` text,
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
	`issuance` text NOT NULL CONSTRAINT `vault_grants_issuance_check` CHECK (`issuance` IN ('target', 'imported-history')),
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
, schema_version integer DEFAULT 1 NOT NULL);
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
, `login_provider` text, `login_account_id` text, `login_quarantined` integer, `login_observations_json` text);
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
CREATE TABLE "worker_backend_sessions" (
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
, `schema_version` integer DEFAULT 1 NOT NULL);
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
CREATE TABLE `workspace_invitations` (
  `invitation_id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `invitee_user_id` text NOT NULL,
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
  CONSTRAINT `workspace_members_revision_check` CHECK (typeof(`revision`) = 'integer' AND `revision` > 0),
  CONSTRAINT `workspace_members_lifecycle_check` CHECK (
    (`status` = 'active' AND `removed_at` IS NULL)
    OR (`status` = 'removed' AND `removed_at` IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "workspace_registry" (
  `workspace_id` text PRIMARY KEY NOT NULL,
  `owner_user_id` text NOT NULL,
  `status` text NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `workspace_registry_status_check` CHECK (`status` IN ('active', 'deleting', 'deleted', 'retired')),
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
CREATE INDEX `audit_events_security_window_idx` ON `audit_events` (`action`,`created_at`,`resource`);
--> statement-breakpoint
CREATE INDEX `audit_events_turn_action_idx` ON `audit_events` (`turn_id`, `action`, `created_at`, `audit_event_id`);
--> statement-breakpoint
CREATE INDEX `audit_events_vault_grant_idx` ON `audit_events` (`vault_grant_id`);
--> statement-breakpoint
CREATE INDEX `audit_events_workspace_idx` ON `audit_events` (`workspace_id`,`category`,`created_at`);
--> statement-breakpoint
CREATE INDEX `boot_audit_events_boot_idx` ON `boot_audit_events` (`boot_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `capability_calls_idempotency_idx` ON `capability_calls` (`request_id`,`family`,`operation`);
--> statement-breakpoint
CREATE INDEX `capability_calls_thread_idx` ON `capability_calls` (`thread_id`,`turn_id`,`started_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `command_log_external_event_idx` ON `idempotency_requests`
  (json_extract(scope_json,'$.scheduleId'), json_extract(scope_json,'$.eventKey'))
  WHERE command_name = 'scheduler.external-trigger.admit';
--> statement-breakpoint
CREATE INDEX `command_log_external_queue_idx` ON `idempotency_requests` (response_id)
  WHERE command_name = 'scheduler.external-trigger.admit';
--> statement-breakpoint
CREATE INDEX `command_receipts_pending_target_idx` ON `idempotency_requests` (coalesce(json_extract(scope_json,'$.approvalRequestId'),json_extract(scope_json,'$.userInputRequestId'),json_extract(scope_json,'$.pendingRequestId')));
--> statement-breakpoint
CREATE INDEX `control_executions_recovery_scope_idx` ON `control_executions` (`work_id`, `phase`)
WHERE `definition_version` = 'core-workspace-recovery/v1';
--> statement-breakpoint
CREATE UNIQUE INDEX `control_execution_steps_recovery_stage_idx`
ON `control_execution_steps` (json_extract(`invocation_json`, '$.carriage.requestId'), json_extract(`invocation_json`, '$.carriage.sequence'))
WHERE json_extract(`control_json`, '$.definitionVersion') = 'core-workspace-recovery/v1';
--> statement-breakpoint
CREATE UNIQUE INDEX `control_execution_steps_harness_consumption_idx`
ON `control_execution_steps` (json_extract(`invocation_json`, '$.carriage.bindingRef'), json_extract(`invocation_json`, '$.carriage.requestId'), json_extract(`invocation_json`, '$.carriage.sequence'))
WHERE json_extract(`control_json`, '$.definitionVersion') = 'core-harness-consume/v1';
--> statement-breakpoint
CREATE INDEX `control_executions_containment_recent_idx`
ON `control_executions` (CAST(json_extract(`span_json`, '$.startTimeUnixNano') AS INTEGER))
WHERE `definition_version` = 'containment';
--> statement-breakpoint
CREATE INDEX `control_execution_steps_containment_clock_idx`
ON `control_execution_steps` (CAST(json_extract(`invocation_json`, '$.clock.admittedUnixNano') AS INTEGER))
WHERE json_extract(`control_json`, '$.definitionVersion') = 'containment'
AND json_extract(`control_json`, '$.kind') = 'fence';
--> statement-breakpoint
CREATE INDEX `control_execution_steps_containment_pending_idx`
ON `control_execution_steps` (`state`)
WHERE json_extract(`control_json`, '$.definitionVersion') = 'containment'
AND json_extract(`control_json`, '$.kind') = 'fence';
--> statement-breakpoint
CREATE INDEX `control_execution_steps_idle_resident_idx`
ON `control_execution_steps` (json_extract(`invocation_json`, '$.carriage.bindingRef'))
WHERE json_extract(`control_json`, '$.definitionVersion') = 'core-idle-cleanup/v1'
  AND json_extract(`invocation_json`, '$.carriage.operation') IN ('bridge.close', 'sandbox.delete')
  AND json_extract(`control_json`, '$.kind') <> 'consume-receipt';
--> statement-breakpoint
CREATE INDEX `control_execution_steps_inspection_idx` ON `control_execution_steps` (`inspected_execution_id`, `inspected_step_id`, `execution_id`, `ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_execution_steps_invocation_idx` ON `control_execution_steps` (`invocation_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_execution_steps_order_idx` ON `control_execution_steps` (`execution_id`, `ordinal`);
--> statement-breakpoint
CREATE INDEX `control_execution_steps_state_idx` ON `control_execution_steps` (`execution_id`, `state`, `ordinal`);
--> statement-breakpoint
CREATE INDEX `control_items_causation_idx` ON `control_product_entries` (json_extract(identity_json,'$.causationId')) WHERE kind='item' AND is_current=1;
--> statement-breakpoint
CREATE INDEX `control_items_request_idx` ON `control_product_entries` (json_extract(read_metadata_json,'$.requestId')) WHERE kind='item' AND is_current=1;
--> statement-breakpoint
CREATE INDEX `control_items_thread_actor_idx` ON `control_product_entries` (json_extract(identity_json, '$.threadId'), json_extract(identity_json, '$.actor.id')) WHERE kind='item' AND revision=1;
--> statement-breakpoint
CREATE INDEX `control_items_thread_read_idx` ON `control_product_entries` (json_extract(identity_json,'$.threadId'),json_extract(identity_json,'$.type'),turn_admission_order,item_order) WHERE kind='item' AND is_current=1;
--> statement-breakpoint
CREATE INDEX `control_items_turn_status_idx` ON `control_product_entries` (turn_id,json_extract(identity_json,'$.type'),json_extract(read_metadata_json,'$.status'),item_order) WHERE kind='item' AND is_current=1;
--> statement-breakpoint
CREATE INDEX `control_items_turn_type_idx` ON `control_product_entries` (`turn_id`, json_extract(identity_json, '$.type'), `sequence`) WHERE kind='item' AND revision=1;
--> statement-breakpoint
CREATE UNIQUE INDEX `control_product_current_idx` ON `control_product_entries` (`kind`,`id`) WHERE is_current=1;
--> statement-breakpoint
CREATE UNIQUE INDEX `control_product_entries_revision_idx` ON `control_product_entries` (`kind`, `id`, `revision`);
--> statement-breakpoint
CREATE INDEX `control_threads_workspace_idx` ON `control_threads` (`workspace_id`, `id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_turns_active_thread_idx` ON `control_turns` (`thread_id`) WHERE `status` IN ('pending', 'running');
--> statement-breakpoint
CREATE UNIQUE INDEX `control_turns_admission_order_idx` ON `control_turns` (`admission_order`);
--> statement-breakpoint
CREATE INDEX `control_turns_thread_admission_idx` ON `control_turns` (`thread_id`, `admission_order`);
--> statement-breakpoint
CREATE INDEX `control_turns_thread_idx` ON `control_turns` (`thread_id`, `id`);
--> statement-breakpoint
CREATE INDEX `control_turns_thread_read_order_idx` ON `control_turns` (`thread_id`,`thread_read_order`);
--> statement-breakpoint
CREATE UNIQUE INDEX discord_account_bindings_active_user ON discord_account_bindings(user_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX `evidence_bundles_status_idx` ON `evidence_bundles` (`import_status`,`retention_class`);
--> statement-breakpoint
CREATE INDEX `evidence_bundles_thread_idx` ON `evidence_bundles` (`thread_id`,`turn_id`);
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
CREATE INDEX notification_attempt_attention ON notification_delivery_attempts (attention_id, id DESC);
--> statement-breakpoint
CREATE INDEX notification_attention_recipient ON notification_attention (recipient_user_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX notification_one_active_attempt ON notification_delivery_attempts (attention_id) WHERE status = 'sending';
--> statement-breakpoint
CREATE UNIQUE INDEX `openkit_access_tokens_hash_idx` ON `openkit_access_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `openkit_access_tokens_run_idx` ON `openkit_access_tokens` (json_extract(`run_subject_json`,'$.attemptId')) WHERE `run_subject_json` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `openkit_access_tokens_plan_idx` ON `openkit_access_tokens` (json_extract(`run_subject_json`,'$.planId')) WHERE `run_subject_json` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `openkit_access_tokens_owner_idx` ON `openkit_access_tokens` (`owner_user_id`,`status`);
--> statement-breakpoint
CREATE INDEX `permission_decisions_enforcement_idx` ON `permission_decisions` (`enforcement_point`,`created_at`);
--> statement-breakpoint
CREATE INDEX `permission_decisions_owner_idx` ON `permission_decisions` (`owner_scope`,`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX recurring_expired_ranges_history_idx
  ON recurring_expired_ranges(schedule_id, first_scheduled_at);
--> statement-breakpoint
CREATE INDEX recurring_occurrences_history_idx
  ON recurring_occurrences(schedule_id, scheduled_at);
--> statement-breakpoint
CREATE INDEX recurring_occurrences_pending_idx
  ON recurring_occurrences(state, deadline);
--> statement-breakpoint
CREATE INDEX recurring_schedules_due_idx
  ON recurring_schedules(status, next_scheduled_at);
--> statement-breakpoint
CREATE UNIQUE INDEX `sandbox_runtime_records_binding_idx` ON `sandbox_runtime_records` (`sandbox_binding_ref`);
--> statement-breakpoint
CREATE UNIQUE INDEX `sandbox_runtime_records_integration_binding_idx` ON `sandbox_runtime_records` (`sandbox_integration_binding_ref`);
--> statement-breakpoint
CREATE INDEX `sandbox_runtime_records_target_idx` ON `sandbox_runtime_records` (`runtime_target_id`,`lifecycle_state`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduler_admission_entries_non_terminal_turn_idx` ON `scheduler_admission_entries` (`turn_id`) WHERE `status` IN ('queued','admitted');
--> statement-breakpoint
CREATE INDEX `scheduler_admission_entries_queue_idx` ON `scheduler_admission_entries` (`status`,`enqueued_at`);
--> statement-breakpoint
CREATE INDEX `scheduler_admission_entries_workspace_idx` ON `scheduler_admission_entries` (`workspace_id`,`status`,`enqueued_at`);
--> statement-breakpoint
CREATE INDEX `scheduler_execution_attempts_deadline_idx` ON `scheduler_execution_attempts` (`phase`, `deadline`);
--> statement-breakpoint
CREATE INDEX `scheduler_execution_attempts_lineage_idx` ON `scheduler_execution_attempts` (`workspace_id`, `thread_id`, `turn_id`, `agent_session_id`, `input_ref`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduler_execution_attempts_live_session_idx` ON `scheduler_execution_attempts` (`agent_session_id`) WHERE `phase` <> 'closed' AND `agent_session_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduler_execution_attempts_live_thread_idx` ON `scheduler_execution_attempts` (`workspace_id`, `thread_id`) WHERE `phase` <> 'closed';
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduler_execution_attempts_live_turn_idx` ON `scheduler_execution_attempts` (`turn_id`) WHERE `phase` <> 'closed';
--> statement-breakpoint
CREATE INDEX `scheduler_execution_attempts_queue_idx` ON `scheduler_execution_attempts` (`queue_entry_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_thread_destination_thread` ON `security_thread_destinations` (`thread_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_trigger_alarm_generation_rule` ON `security_trigger_alarms` (`enable_generation`, `rule`);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_trigger_assessment_source` ON `security_trigger_audit_assessments` (`source_rowid`);
--> statement-breakpoint
CREATE INDEX `security_trigger_assessment_page` ON `security_trigger_audit_assessments` (`created_at`,`audit_event_id`);
--> statement-breakpoint
CREATE INDEX `security_trigger_outbox_event` ON `security_trigger_outbox` (`audit_event_id`);
--> statement-breakpoint
CREATE INDEX `security_trigger_outbox_alarm` ON `security_trigger_outbox` (`alarm_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_trigger_outbox_occurrence` ON `security_trigger_outbox` (`key_json`, `recipient_user_id`, `occurrence_kind`, `occurrence_n`);
--> statement-breakpoint
CREATE INDEX `security_trigger_outbox_pending` ON `security_trigger_outbox` (`raised`, `created_at`, `request_id`);
--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);
--> statement-breakpoint
CREATE INDEX `usage_records_capability_call_idx` ON `usage_records` (`capability_call_id`);
--> statement-breakpoint
CREATE INDEX `usage_records_thread_idx` ON `usage_records` (`thread_id`,`turn_id`,`recorded_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_personal_workspace_id_unique` ON `users` (`personal_workspace_id`);
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
CREATE TRIGGER `control_execution_steps_parent_prior` BEFORE INSERT ON `control_execution_steps`
WHEN NEW.`parent_step_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `control_execution_steps` WHERE `execution_id` = NEW.`execution_id` AND `step_id` = NEW.`parent_step_id` AND `ordinal` < NEW.`ordinal`
)
BEGIN SELECT RAISE(ABORT, 'Execution parent must be a prior step in the same execution.'); END;
--> statement-breakpoint
CREATE TRIGGER `control_execution_steps_root_identity` BEFORE INSERT ON `control_execution_steps`
WHEN NOT EXISTS (
  SELECT 1 FROM `control_executions` WHERE `id` = NEW.`execution_id`
    AND `work_id` = json_extract(NEW.`control_json`, '$.workId')
    AND `definition_version` = json_extract(NEW.`control_json`, '$.definitionVersion')
)
BEGIN SELECT RAISE(ABORT, 'Execution step control must match its root identity.'); END;
--> statement-breakpoint
CREATE TRIGGER `control_execution_steps_settle_once` BEFORE UPDATE ON `control_execution_steps`
WHEN OLD.`state` <> 'intent' OR NEW.`state` = 'intent'
  OR NEW.`execution_id` IS NOT OLD.`execution_id` OR NEW.`step_id` IS NOT OLD.`step_id`
  OR NEW.`schema_version` IS NOT OLD.`schema_version` OR NEW.`ordinal` IS NOT OLD.`ordinal`
  OR NEW.`parent_step_id` IS NOT OLD.`parent_step_id` OR NEW.`invocation_id` IS NOT OLD.`invocation_id`
  OR NEW.`inspected_execution_id` IS NOT OLD.`inspected_execution_id` OR NEW.`inspected_step_id` IS NOT OLD.`inspected_step_id`
  OR NEW.`invocation_json` IS NOT OLD.`invocation_json`
  OR json_remove(NEW.`control_json`, '$.outputRefs') IS NOT json_remove(OLD.`control_json`, '$.outputRefs')
  OR json_extract(NEW.`span_json`, '$.traceId') IS NOT json_extract(OLD.`span_json`, '$.traceId')
  OR json_extract(NEW.`span_json`, '$.spanId') IS NOT json_extract(OLD.`span_json`, '$.spanId')
  OR json_extract(NEW.`span_json`, '$.parentSpanId') IS NOT json_extract(OLD.`span_json`, '$.parentSpanId')
  OR json_extract(NEW.`span_json`, '$.startTimeUnixNano') IS NOT json_extract(OLD.`span_json`, '$.startTimeUnixNano')
  OR json_extract(NEW.`span_json`, '$.name') IS NOT json_extract(OLD.`span_json`, '$.name')
  OR json_extract(NEW.`span_json`, '$.kind') IS NOT json_extract(OLD.`span_json`, '$.kind')
BEGIN SELECT RAISE(ABORT, 'Execution step identity is immutable and an outcome settles once.'); END;
--> statement-breakpoint
CREATE TRIGGER `control_executions_identity_immutable` BEFORE UPDATE ON `control_executions`
WHEN NEW.`id` IS NOT OLD.`id` OR NEW.`schema_version` IS NOT OLD.`schema_version`
  OR NEW.`owner_json` IS NOT OLD.`owner_json` OR NEW.`work_id` IS NOT OLD.`work_id`
  OR NEW.`definition_version` IS NOT OLD.`definition_version` OR NEW.`input_fingerprint` IS NOT OLD.`input_fingerprint`
  OR json_extract(NEW.`span_json`, '$.traceId') IS NOT json_extract(OLD.`span_json`, '$.traceId')
  OR json_extract(NEW.`span_json`, '$.spanId') IS NOT json_extract(OLD.`span_json`, '$.spanId')
  OR json_extract(NEW.`span_json`, '$.startTimeUnixNano') IS NOT json_extract(OLD.`span_json`, '$.startTimeUnixNano')
  OR (OLD.`phase` = 'closed' AND NEW.`phase` <> 'closed')
BEGIN SELECT RAISE(ABORT, 'Execution identity is immutable and closed executions cannot reopen.'); END;
--> statement-breakpoint
CREATE TRIGGER control_product_read_index_insert AFTER INSERT ON control_product_entries BEGIN
  UPDATE control_product_entries SET is_current=0 WHERE kind=NEW.kind AND id=NEW.id AND is_current=1;
  UPDATE control_product_entries SET is_current=1,
    turn_admission_order=(SELECT admission_order FROM control_turns WHERE id=NEW.turn_id),
    item_order=(SELECT sequence FROM control_product_entries WHERE kind=NEW.kind AND id=NEW.id AND revision=1)
    WHERE rowid=NEW.rowid;
END;
--> statement-breakpoint
CREATE TRIGGER `control_turns_assign_admission_order` AFTER INSERT ON `control_turns`
WHEN NEW.admission_order = 0
BEGIN
  UPDATE control_turns SET admission_order = (SELECT max(admission_order) + 1 FROM control_turns) WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER `control_turns_keep_admission_order` BEFORE UPDATE OF admission_order ON `control_turns`
WHEN OLD.admission_order > 0 AND NEW.admission_order != OLD.admission_order
BEGIN
  SELECT RAISE(ABORT, 'Turn admission order is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER control_turns_read_order_delete AFTER DELETE ON control_turns BEGIN
  UPDATE control_turns SET thread_read_order=thread_read_order-1 WHERE thread_id=OLD.thread_id AND thread_read_order>OLD.thread_read_order;
END;
--> statement-breakpoint
CREATE TRIGGER control_turns_read_order_insert AFTER INSERT ON control_turns BEGIN
  UPDATE control_turns SET thread_read_order=(SELECT coalesce(max(thread_read_order),0)+1 FROM control_turns WHERE thread_id=NEW.thread_id AND id<>NEW.id) WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_owner_member_delete_guard`
BEFORE DELETE ON `workspace_members`
WHEN EXISTS (
  SELECT 1 FROM `workspace_registry`
  WHERE `workspace_id` = OLD.`workspace_id` AND `owner_user_id` = OLD.`user_id`
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_owner_membership_required');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_owner_member_update_guard`
BEFORE UPDATE OF `workspace_id`, `user_id`, `status` ON `workspace_members`
WHEN EXISTS (
  SELECT 1 FROM `workspace_registry`
  WHERE `workspace_id` = OLD.`workspace_id` AND `owner_user_id` = OLD.`user_id`
)
AND (NEW.`workspace_id` <> OLD.`workspace_id` OR NEW.`user_id` <> OLD.`user_id` OR NEW.`status` <> 'active')
BEGIN
  SELECT RAISE(ABORT, 'workspace_owner_membership_required');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_owner_transfer_guard`
BEFORE UPDATE OF `owner_user_id` ON `workspace_registry`
WHEN NOT EXISTS (
  SELECT 1 FROM `workspace_members`
  WHERE `workspace_id` = OLD.`workspace_id` AND `user_id` = NEW.`owner_user_id` AND `status` = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_owner_membership_required');
END;
--> statement-breakpoint
INSERT INTO `security_trigger_state` (`singleton`) VALUES (1);
--> statement-breakpoint
INSERT INTO `security_trigger_audit_progress` (`singleton`) VALUES (1);
