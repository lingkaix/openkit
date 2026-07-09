CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `id` text PRIMARY KEY NOT NULL,
  `applied_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_repository_resources` (
  `workspace_id` text NOT NULL,
  `resource_id` text NOT NULL,
  `type` text NOT NULL,
  `display_name` text NOT NULL,
  `local_path` text NOT NULL,
  `diagnostics_status` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY(`workspace_id`, `resource_id`)
);
--> statement-breakpoint
CREATE TABLE `worker_turn_checkpoints` (
	`checkpoint_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`goal_id` text,
	`task_id` text,
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
--> statement-breakpoint
CREATE INDEX `worker_turn_checkpoints_scope_idx` ON `worker_turn_checkpoints` (`workspace_id`,`thread_id`,`turn_id`);
--> statement-breakpoint
CREATE INDEX `worker_turn_checkpoints_updated_idx` ON `worker_turn_checkpoints` (`updated_at`);
--> statement-breakpoint
CREATE TABLE `pending_user_turns` (
	`pending_turn_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`request_id` text NOT NULL,
	`content_item_id` text,
	`content_digest` text,
	`queue_mode` text NOT NULL,
	`received_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_user_turns_scope_idx` ON `pending_user_turns` (`workspace_id`,`thread_id`,`received_at`,`pending_turn_id`);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `goal_records_thread_idx` ON `goal_records` (`workspace_id`,`thread_id`,`updated_at`,`goal_id`);
--> statement-breakpoint
CREATE TABLE `goal_tasks` (
	`task_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`objective` text NOT NULL,
	`order_index` integer NOT NULL,
	`depends_on_task_ids_json` text NOT NULL,
	`acceptance_criteria_json` text NOT NULL,
	`context_budget_tokens` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`thread_id`,`goal_id`,`task_id`)
);
--> statement-breakpoint
CREATE INDEX `goal_tasks_goal_order_idx` ON `goal_tasks` (`workspace_id`,`thread_id`,`goal_id`,`order_index`,`task_id`);
--> statement-breakpoint
CREATE TABLE `goal_review_records` (
	`review_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`task_id` text NOT NULL,
	`turn_id` text,
	`item_ids_json` text NOT NULL,
	`artifact_ids_json` text NOT NULL,
	`verification_evidence_json` text NOT NULL,
	`verdict` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`resolved_at` text,
	`resolution_request_id` text,
	PRIMARY KEY(`workspace_id`,`thread_id`,`goal_id`,`review_id`)
);
--> statement-breakpoint
CREATE INDEX `goal_review_records_task_idx` ON `goal_review_records` (`workspace_id`,`thread_id`,`goal_id`,`task_id`,`created_at`,`review_id`);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `goal_verification_records_goal_idx` ON `goal_verification_records` (`workspace_id`,`thread_id`,`goal_id`,`created_at`,`verification_id`);
--> statement-breakpoint
CREATE INDEX `goal_verification_records_task_idx` ON `goal_verification_records` (`workspace_id`,`thread_id`,`goal_id`,`task_id`,`created_at`,`verification_id`);
--> statement-breakpoint
ALTER TABLE `goal_tasks` ADD `verification_checks_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `workspace_apply_results_review_idx` ON `workspace_apply_results` (`workspace_id`,`review_id`,`applied_at`,`apply_result_id`);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `workspace_input_snapshots_resource_idx` ON `workspace_input_snapshots` (`workspace_id`,`resource_id`,`created_at`,`input_snapshot_id`);
--> statement-breakpoint
CREATE TABLE `workspace_materialization_records` (
	`materialization_record_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`input_snapshot_id` text NOT NULL,
	`worker_session_id` text NOT NULL,
	`strategy` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`materialization_record_id`)
);
--> statement-breakpoint
CREATE INDEX `workspace_materialization_records_input_idx` ON `workspace_materialization_records` (`workspace_id`,`input_snapshot_id`,`created_at`,`materialization_record_id`);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `workspace_change_sets_materialization_idx` ON `workspace_change_sets` (`workspace_id`,`materialization_record_id`,`created_at`,`change_set_id`);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `staged_workspace_reviews_change_set_idx` ON `staged_workspace_reviews` (`workspace_id`,`change_set_id`,`updated_at`,`review_id`);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `workspace_filesystem_staging_change_set_idx` ON `workspace_filesystem_staging_roots` (`workspace_id`,`change_set_id`,`updated_at`,`review_id`);
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
CREATE INDEX `permission_decisions_owner_idx` ON `permission_decisions` (`owner_scope`,`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `permission_decisions_enforcement_idx` ON `permission_decisions` (`enforcement_point`,`created_at`);
--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `capability_calls_idempotency_idx` ON `capability_calls` (`workspace_id`,`request_id`,`family`,`operation`);
--> statement-breakpoint
CREATE INDEX `capability_calls_workspace_idx` ON `capability_calls` (`workspace_id`,`status`,`started_at`);
--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `usage_records_workspace_idx` ON `usage_records` (`workspace_id`,`category`,`recorded_at`);
--> statement-breakpoint
CREATE INDEX `usage_records_capability_call_idx` ON `usage_records` (`capability_call_id`);
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
);
--> statement-breakpoint
CREATE INDEX `audit_events_workspace_idx` ON `audit_events` (`workspace_id`,`category`,`created_at`);
--> statement-breakpoint
CREATE INDEX `audit_events_capability_call_idx` ON `audit_events` (`capability_call_id`);
--> statement-breakpoint
CREATE INDEX `audit_events_request_idx` ON `audit_events` (`request_id`);
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
CREATE INDEX `vault_use_records_owner_idx` ON `vault_use_records` (`owner_scope`,`workspace_id`,`outcome`);
--> statement-breakpoint
CREATE INDEX `vault_use_records_reference_idx` ON `vault_use_records` (`vault_reference_id`,`material_version`,`outcome`);
--> statement-breakpoint
CREATE INDEX `vault_use_records_resolution_idx` ON `vault_use_records` (`grant_id`,`plan_id`,`receipt_id`);
--> statement-breakpoint
CREATE INDEX `vault_use_records_actor_idx` ON `vault_use_records` (`agent_session_id`,`capability_call_id`);
--> statement-breakpoint
ALTER TABLE `workspace_repository_resources` ADD COLUMN `commit_on_apply` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `workspace_repository_resources` ADD COLUMN `git_author_name` text;
ALTER TABLE `workspace_repository_resources` ADD COLUMN `git_author_email` text;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `git_push_records_repository_idx` ON `git_push_records` (`workspace_id`,`repository_resource_id`,`created_at`,`push_record_id`);
--> statement-breakpoint
ALTER TABLE `workspace_repository_resources` ADD COLUMN `staging_strategy` text NOT NULL DEFAULT 'staging-root';
--> statement-breakpoint
ALTER TABLE `workspace_repository_resources` ADD COLUMN `protected_branch_patterns_json` text NOT NULL DEFAULT '["main","master","release/*","v*"]';
--> statement-breakpoint
ALTER TABLE `workspace_repository_resources` ADD COLUMN `allowed_push_targets_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `workspace_repository_resources` ADD COLUMN `require_review_linkage` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_tool_schema_snapshots_digest_idx` ON `mcp_tool_schema_snapshots` (`workspace_id`,`catalog_entry_id`,`source`,`content_digest`);
--> statement-breakpoint
CREATE INDEX `mcp_tool_schema_snapshots_workspace_idx` ON `mcp_tool_schema_snapshots` (`workspace_id`,`catalog_entry_id`,`captured_at`);
--> statement-breakpoint
CREATE TABLE `resolved_agent_setups` (
	`setup_record_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`turn_id` text,
	`request_id` text,
	`agent_id` text NOT NULL,
	`provider_id` text,
	`runtime_kind` text NOT NULL,
	`runtime_adapter` text NOT NULL,
	`required_features_json` text NOT NULL,
	`setup_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`setup_record_id`)
);
--> statement-breakpoint
CREATE INDEX `resolved_agent_setups_agent_idx` ON `resolved_agent_setups` (`workspace_id`,`agent_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `resolved_agent_setups_turn_idx` ON `resolved_agent_setups` (`workspace_id`,`turn_id`);
--> statement-breakpoint
CREATE TABLE `agent_environment_package_snapshots` (
	`snapshot_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`package_id` text NOT NULL,
	`runtime_kind` text NOT NULL,
	`backend_kind` text NOT NULL,
	`content_digest` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`snapshot_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `aep_snapshots_digest_idx` ON `agent_environment_package_snapshots` (`workspace_id`,`content_digest`);
--> statement-breakpoint
CREATE INDEX `aep_snapshots_turn_idx` ON `agent_environment_package_snapshots` (`workspace_id`,`turn_id`,`agent_session_id`);
--> statement-breakpoint
ALTER TABLE `audit_events` ADD COLUMN `permission_decision_id` text;
--> statement-breakpoint
ALTER TABLE `audit_events` ADD COLUMN `vault_grant_id` text;
--> statement-breakpoint
CREATE INDEX `audit_events_permission_decision_idx` ON `audit_events` (`permission_decision_id`);
--> statement-breakpoint
CREATE INDEX `audit_events_vault_grant_idx` ON `audit_events` (`vault_grant_id`);
--> statement-breakpoint
ALTER TABLE `workspace_repository_resources` ADD COLUMN `git_push_vault_grant_ref` text;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `evidence_bundles_workspace_idx` ON `evidence_bundles` (`workspace_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `evidence_bundles_thread_idx` ON `evidence_bundles` (`workspace_id`, `thread_id`, `turn_id`);
--> statement-breakpoint
CREATE INDEX `evidence_bundles_goal_idx` ON `evidence_bundles` (`workspace_id`, `goal_id`);
--> statement-breakpoint
CREATE INDEX `evidence_bundles_status_idx` ON `evidence_bundles` (`import_status`, `retention_class`);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `runtime_evidence_workspace_idx` ON `runtime_evidence` (`workspace_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `runtime_evidence_thread_idx` ON `runtime_evidence` (`workspace_id`, `thread_id`, `turn_id`);
--> statement-breakpoint
CREATE INDEX `runtime_evidence_agent_session_idx` ON `runtime_evidence` (`workspace_id`, `agent_session_id`);
--> statement-breakpoint
CREATE INDEX `runtime_evidence_phase_idx` ON `runtime_evidence` (`phase`, `outcome`);
--> statement-breakpoint
CREATE TABLE `backend_workspace_handles` (
	`backend_workspace_handle_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`materialization_record_id` text NOT NULL,
	`backend_kind` text NOT NULL,
	`worker_session_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`backend_workspace_handle_id`)
);
--> statement-breakpoint
CREATE INDEX `backend_workspace_handles_materialization_idx` ON `backend_workspace_handles` (`workspace_id`,`materialization_record_id`,`created_at`,`backend_workspace_handle_id`);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `worker_output_manifests_materialization_idx` ON `worker_output_manifests` (`workspace_id`,`materialization_record_id`,`created_at`,`worker_output_manifest_id`);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `workspace_apply_plans_review_idx` ON `workspace_apply_plans` (`workspace_id`,`review_id`,`created_at`,`apply_plan_id`);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `workspace_reconciliation_records_state_idx` ON `workspace_reconciliation_records` (`workspace_id`,`state_after`,`started_at`,`reconciliation_record_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS workspace_quarantine_records (
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

CREATE INDEX IF NOT EXISTS idx_workspace_quarantine_records_workspace_resolution_created
  ON workspace_quarantine_records (workspace_id, resolution, created_at, quarantine_record_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS workspace_sync_evidence_bundles (
  sync_evidence_bundle_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, sync_evidence_bundle_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_sync_evidence_bundles_workspace_created
  ON workspace_sync_evidence_bundles (workspace_id, created_at, sync_evidence_bundle_id);
