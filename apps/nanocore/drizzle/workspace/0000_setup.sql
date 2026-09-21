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
, `package_snapshot_id` text, `schema_snapshot_id` text, `runtime_origin_ref` text, `runtime_cache_lineage_ref` text, `system_prompt_digest` text,
	CONSTRAINT `capability_calls_system_prompt_digest_check` CHECK (`system_prompt_digest` IS NULL OR (`family` = 'llm' AND `capability_id` IN ('llm.chat_completions', 'llm.responses')))
);

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
	`worker_storage_choice_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`thread_id`,`goal_id`)
);

--> statement-breakpoint

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

--> statement-breakpoint

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

--> statement-breakpoint

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
, `responsible_user_id` text);

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

--> statement-breakpoint

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

--> statement-breakpoint

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

--> statement-breakpoint

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

--> statement-breakpoint

CREATE UNIQUE INDEX `artifact_reviews_identity_idx` ON `artifact_reviews` (`workspace_id`,`review_id`);

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

CREATE INDEX `backend_workspace_handles_materialization_idx` ON `backend_workspace_handles` (`workspace_id`,`materialization_record_id`,`created_at`,`backend_workspace_handle_id`);

--> statement-breakpoint

CREATE INDEX `backend_workspace_handles_package_idx` ON `backend_workspace_handles` (`workspace_id`,`package_snapshot_id`,`created_at`,`backend_workspace_handle_id`);

--> statement-breakpoint

CREATE UNIQUE INDEX `capability_calls_idempotency_idx` ON `capability_calls` (`workspace_id`,`request_id`,`family`,`operation`);

--> statement-breakpoint

CREATE INDEX `capability_calls_workspace_idx` ON `capability_calls` (`workspace_id`,`status`,`started_at`);

--> statement-breakpoint

CREATE INDEX `evidence_bundles_goal_idx` ON `evidence_bundles` (`workspace_id`, `goal_id`);

--> statement-breakpoint

CREATE INDEX `evidence_bundles_status_idx` ON `evidence_bundles` (`import_status`, `retention_class`);

--> statement-breakpoint

CREATE INDEX `evidence_bundles_thread_idx` ON `evidence_bundles` (`workspace_id`, `thread_id`, `turn_id`);

--> statement-breakpoint

CREATE INDEX `evidence_bundles_workspace_idx` ON `evidence_bundles` (`workspace_id`, `created_at`);

--> statement-breakpoint

CREATE INDEX `git_push_records_repository_idx` ON `git_push_records` (`workspace_id`,`repository_resource_id`,`created_at`,`push_record_id`);

--> statement-breakpoint

CREATE INDEX `goal_plan_records_goal_idx` ON `goal_plan_records` (`workspace_id`,`thread_id`,`goal_id`,`created_at`,`plan_item_id`);

--> statement-breakpoint

CREATE INDEX `goal_records_thread_idx` ON `goal_records` (`workspace_id`,`thread_id`,`updated_at`,`goal_id`);

--> statement-breakpoint

CREATE INDEX `goal_review_records_task_idx` ON `goal_review_records` (`workspace_id`,`thread_id`,`goal_id`,`task_id`,`created_at`,`review_id`);

--> statement-breakpoint

CREATE INDEX `goal_tasks_goal_order_idx` ON `goal_tasks` (`workspace_id`,`thread_id`,`goal_id`,`order_index`,`task_id`);

--> statement-breakpoint

CREATE INDEX `goal_verification_records_goal_idx` ON `goal_verification_records` (`workspace_id`,`thread_id`,`goal_id`,`created_at`,`verification_id`);

--> statement-breakpoint

CREATE INDEX `goal_verification_records_task_idx` ON `goal_verification_records` (`workspace_id`,`thread_id`,`goal_id`,`task_id`,`created_at`,`verification_id`);

--> statement-breakpoint

CREATE INDEX idx_workspace_quarantine_records_workspace_resolution_created
  ON workspace_quarantine_records (workspace_id, resolution, created_at, quarantine_record_id);

--> statement-breakpoint

CREATE UNIQUE INDEX `mcp_tool_schema_snapshots_digest_idx` ON `mcp_tool_schema_snapshots` (`workspace_id`,`catalog_entry_id`,`source`,`content_digest`);

--> statement-breakpoint

CREATE INDEX `mcp_tool_schema_snapshots_workspace_idx` ON `mcp_tool_schema_snapshots` (`workspace_id`,`catalog_entry_id`,`captured_at`);

--> statement-breakpoint

CREATE UNIQUE INDEX `pending_user_turn_records_identity_idx` ON `pending_user_turn_records` (`workspace_id`,`pending_turn_id`);

--> statement-breakpoint

CREATE INDEX `permission_decisions_enforcement_idx` ON `permission_decisions` (`enforcement_point`,`created_at`);

--> statement-breakpoint

CREATE INDEX `permission_decisions_owner_idx` ON `permission_decisions` (`owner_scope`,`workspace_id`,`created_at`);

--> statement-breakpoint

CREATE UNIQUE INDEX `permission_decisions_terminal_approval_idx`
ON `permission_decisions` (`approval_id`)
WHERE `owner_scope` = 'workspace'
  AND `approval_id` IS NOT NULL
  AND `result` IN ('allow', 'deny');

--> statement-breakpoint

CREATE INDEX `resolved_agent_setups_agent_idx` ON `resolved_agent_setups` (`workspace_id`,`agent_id`,`created_at`);

--> statement-breakpoint

CREATE INDEX `resolved_agent_setups_turn_idx` ON `resolved_agent_setups` (`workspace_id`,`turn_id`);

--> statement-breakpoint

CREATE INDEX `runtime_evidence_agent_session_idx` ON `runtime_evidence` (`workspace_id`, `agent_session_id`);

--> statement-breakpoint

CREATE INDEX `runtime_evidence_phase_idx` ON `runtime_evidence` (`phase`, `outcome`);

--> statement-breakpoint

CREATE INDEX `runtime_evidence_thread_idx` ON `runtime_evidence` (`workspace_id`, `thread_id`, `turn_id`);

--> statement-breakpoint

CREATE INDEX `runtime_evidence_workspace_idx` ON `runtime_evidence` (`workspace_id`, `created_at`);

--> statement-breakpoint

CREATE INDEX `staged_workspace_reviews_change_set_idx` ON `staged_workspace_reviews` (`workspace_id`,`change_set_id`,`updated_at`,`review_id`);

--> statement-breakpoint

CREATE UNIQUE INDEX `steering_terminal_outcomes_identity_idx` ON `steering_terminal_outcomes` (`workspace_id`,`outcome_id`);

--> statement-breakpoint

CREATE UNIQUE INDEX `steering_terminal_outcomes_terminal_request_idx` ON `steering_terminal_outcomes` (`workspace_id`,`thread_id`,`terminal_request_id`);

--> statement-breakpoint

CREATE UNIQUE INDEX `thread_material_bindings_bound_thread_idx` ON `thread_material_bindings` (`workspace_id`,`thread_id`) WHERE `binding_state` = 'bound';

--> statement-breakpoint

CREATE INDEX `thread_material_bindings_material_queue_idx` ON `thread_material_bindings` (`workspace_id`,`material_id`,`binding_state`,`thread_id`);

--> statement-breakpoint

CREATE INDEX `usage_records_capability_call_idx` ON `usage_records` (`capability_call_id`);

--> statement-breakpoint

CREATE INDEX `usage_records_workspace_idx` ON `usage_records` (`workspace_id`,`category`,`recorded_at`);

--> statement-breakpoint

CREATE INDEX `vault_use_records_actor_idx` ON `vault_use_records` (`agent_session_id`,`capability_call_id`);

--> statement-breakpoint

CREATE INDEX `vault_use_records_owner_idx` ON `vault_use_records` (`owner_scope`,`workspace_id`,`outcome`);

--> statement-breakpoint

CREATE INDEX `vault_use_records_reference_idx` ON `vault_use_records` (`vault_reference_id`,`material_version`,`outcome`);

--> statement-breakpoint

CREATE INDEX `vault_use_records_resolution_idx` ON `vault_use_records` (`grant_id`,`plan_id`,`receipt_id`);

--> statement-breakpoint

CREATE INDEX `worker_output_manifests_materialization_idx` ON `worker_output_manifests` (`workspace_id`,`materialization_record_id`,`created_at`,`worker_output_manifest_id`);

--> statement-breakpoint

CREATE INDEX `worker_turn_checkpoints_scope_idx` ON `worker_turn_checkpoints` (`workspace_id`,`thread_id`,`turn_id`);

--> statement-breakpoint

CREATE INDEX `worker_turn_checkpoints_updated_idx` ON `worker_turn_checkpoints` (`updated_at`);

--> statement-breakpoint

CREATE INDEX `workspace_apply_plans_review_idx` ON `workspace_apply_plans` (`workspace_id`,`review_id`,`created_at`,`apply_plan_id`);

--> statement-breakpoint

CREATE INDEX `workspace_apply_results_review_idx` ON `workspace_apply_results` (`workspace_id`,`review_id`,`applied_at`,`apply_result_id`);

--> statement-breakpoint

CREATE INDEX `workspace_change_sets_materialization_idx` ON `workspace_change_sets` (`workspace_id`,`materialization_record_id`,`created_at`,`change_set_id`);

--> statement-breakpoint

CREATE INDEX `workspace_filesystem_staging_change_set_idx` ON `workspace_filesystem_staging_roots` (`workspace_id`,`change_set_id`,`updated_at`,`review_id`);

--> statement-breakpoint

CREATE INDEX `workspace_input_snapshots_resource_idx` ON `workspace_input_snapshots` (`workspace_id`,`resource_id`,`created_at`,`input_snapshot_id`);

--> statement-breakpoint

CREATE UNIQUE INDEX `workspace_material_revisions_child_idx` ON `workspace_material_revisions` (`workspace_id`,`material_id`,`parent_revision_id`) WHERE `parent_revision_id` IS NOT NULL;

--> statement-breakpoint

CREATE INDEX `workspace_material_revisions_list_idx` ON `workspace_material_revisions` (`workspace_id`,`material_id`,`created_at`,`revision_id`);

--> statement-breakpoint

CREATE UNIQUE INDEX `workspace_material_revisions_root_idx` ON `workspace_material_revisions` (`workspace_id`,`material_id`) WHERE `parent_revision_id` IS NULL;

--> statement-breakpoint

CREATE INDEX `workspace_materialization_records_input_idx` ON `workspace_materialization_records` (`workspace_id`,`input_snapshot_id`,`created_at`,`materialization_record_id`);

--> statement-breakpoint

CREATE INDEX `workspace_materialization_records_package_idx` ON `workspace_materialization_records` (`workspace_id`,`package_snapshot_id`,`created_at`,`materialization_record_id`);

--> statement-breakpoint

CREATE INDEX `workspace_materials_list_idx` ON `workspace_materials` (`workspace_id`,`created_at`,`material_id`);

--> statement-breakpoint

CREATE INDEX `workspace_reconciliation_records_state_idx` ON `workspace_reconciliation_records` (`workspace_id`,`state_after`,`started_at`,`reconciliation_record_id`);

--> statement-breakpoint

CREATE TABLE `generative_presentations` (
  `presentation_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `thread_id` text NOT NULL,
  `turn_id` text NOT NULL,
  `item_id` text NOT NULL,
  `created_at` text NOT NULL,
  `actor_json` text NOT NULL,
  `request_id` text,
  `origin_request_id` text,
  `semantic_input_hash` text NOT NULL,
  `title` text NOT NULL,
  `fallback_text` text NOT NULL,
  `protocol_version` text NOT NULL,
  `catalog_id` text NOT NULL,
  `messages_json` text NOT NULL,
  `content_digest` text NOT NULL,
  `source_json` text NOT NULL,
  `actions_json` text NOT NULL,
  `observed_at` text NOT NULL,
  PRIMARY KEY(`workspace_id`, `presentation_id`)
);

--> statement-breakpoint

CREATE UNIQUE INDEX `generative_presentations_request_idx`
ON `generative_presentations` (`workspace_id`, `request_id`)
WHERE `request_id` IS NOT NULL;

--> statement-breakpoint

CREATE INDEX `generative_presentations_thread_idx`
ON `generative_presentations` (`workspace_id`, `thread_id`, `created_at`, `presentation_id`);
