-- Pre-v0.1.0 fresh baseline. Edit this file directly before the first stable release.
-- This initializes an empty scope; it does not upgrade a predecessor database.
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
	`created_at` text NOT NULL, `range_feedback` text, `schema_version` integer DEFAULT 1 NOT NULL, `judgements` text NOT NULL DEFAULT '[]', read_goal_id text,
	PRIMARY KEY(`workspace_id`,`artifact_id`,`artifact_version`),
	CONSTRAINT `artifact_reviews_review_id_check` CHECK (length(`review_id`) = 41 AND `review_id` GLOB 'arev_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[57][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
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
CHECK (`resource_revision` IS NULL OR (typeof(`resource_revision`) = 'integer' AND `resource_revision` > 0)), `notebook_admission_json` text, `schema_version` integer NOT NULL, `policy_invocation_json` text, `policy_write_outcome_json` text, `authentication_json` text);
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
	`updated_at` text NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
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
	`extensions_json` text, `schema_version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `capability_calls_system_prompt_digest_check` CHECK (`system_prompt_digest` IS NULL OR (`family` = 'llm' AND `capability_id` IN ('llm.chat_completions', 'llm.responses')))
);
--> statement-breakpoint
CREATE TABLE `control_agent_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `control_workspaces` (`id`),
  `thread_id` text REFERENCES `control_threads` (`id`),
  `status` text NOT NULL CHECK (`status` IN ('created', 'initializing', 'ready', 'busy', 'idle', 'degraded', 'interrupted', 'failed', 'closed')),
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `revision` integer NOT NULL CHECK (`revision` > 0),
  `record_json` text NOT NULL CHECK (json_valid(`record_json`))
);
--> statement-breakpoint
CREATE TABLE "control_execution_steps" (
  `execution_id` text NOT NULL REFERENCES `control_executions` (`id`),
  `step_id` text NOT NULL CHECK (length(`step_id`) > 0),
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `ordinal` integer NOT NULL CHECK (typeof(`ordinal`) = 'integer' AND `ordinal` BETWEEN 1 AND 9007199254740991),
  `parent_step_id` text CHECK (`parent_step_id` IS NULL OR `parent_step_id` <> `step_id`),
  `state` text NOT NULL CHECK (`state` IN ('intent', 'completed', 'failed', 'unknown', 'cancelled')),
  `invocation_id` text NOT NULL CHECK (length(`invocation_id`) > 0),
  `control_json` text NOT NULL CHECK (COALESCE(json_valid(`control_json`) AND json_type(`control_json`) = 'object' AND json_type(`control_json`, '$.definitionVersion') = 'text' AND json_extract(`control_json`, '$.kind') IN ('resolve-setup', 'validate-setup', 'materialize', 'open-session', 'inspect-session', 'deliver-start', 'deliver-steer', 'collect', 'terminal-publication', 'cancel', 'consume-receipt', 'inspect-cleanup', 'release') AND json_type(`control_json`, '$.workId') = 'text' AND json_extract(`control_json`, '$.invocationId') = `invocation_id` AND json_type(`control_json`, '$.actor') = 'object' AND json_type(`control_json`, '$.inputRefs') = 'array' AND json_type(`control_json`, '$.outputRefs') = 'array' AND json_type(`control_json`, '$.authorityRefs') = 'array' AND json_type(`control_json`, '$.physicalFenceRefs') = 'array' AND json_type(`control_json`, '$.retryPermitted') IN ('true', 'false') AND json_type(`control_json`, '$.deadlineUnixNano') IN ('text', 'null') AND json_type(`control_json`, '$.target') IN ('object', 'null'), 0)),
  `invocation_json` text NOT NULL CHECK (COALESCE(json_valid(`invocation_json`) AND json_type(`invocation_json`) = 'object' AND json_type(`invocation_json`, '$.parent') IN ('object', 'null') AND json_type(`invocation_json`, '$.carriage') = 'object' AND json_type(`invocation_json`, '$.clock') = 'object' AND json_type(`invocation_json`, '$.clock.processWitness') = 'text' AND json_type(`invocation_json`, '$.clock.admittedUnixNano') = 'text' AND json_type(`invocation_json`, '$.clock.admittedMonotonicNano') = 'text' AND json_type(`invocation_json`, '$.remainingMs') IS NULL, 0)),
  `span_json` text NOT NULL CHECK (COALESCE(json_valid(`span_json`) AND json_type(`span_json`) = 'object' AND json_type(`span_json`, '$.startTimeUnixNano') = 'text' AND json_type(`span_json`, '$.endTimeUnixNano') IN ('text', 'null'), 0)),
  `inspected_execution_id` text,
  `inspected_step_id` text,
  PRIMARY KEY (`execution_id`, `step_id`),
  FOREIGN KEY (`execution_id`, `parent_step_id`) REFERENCES "control_execution_steps" (`execution_id`, `step_id`),
  FOREIGN KEY (`inspected_execution_id`, `inspected_step_id`) REFERENCES "control_execution_steps" (`execution_id`, `step_id`),
  CHECK ((`inspected_execution_id` IS NULL) = (`inspected_step_id` IS NULL)),
  CHECK (`inspected_execution_id` IS NULL OR `inspected_execution_id` <> `execution_id` OR `inspected_step_id` <> `step_id`),
  CHECK (COALESCE((`state` = 'intent' AND json_type(`span_json`, '$.endTimeUnixNano') = 'null') OR (`state` <> 'intent' AND json_type(`span_json`, '$.endTimeUnixNano') = 'text'), 0)),
  CHECK (`state` <> 'unknown' OR COALESCE(json_extract(`span_json`, '$.status.code') = 'ERROR', 0))
);
--> statement-breakpoint
CREATE TABLE `control_executions` (
  `id` text PRIMARY KEY NOT NULL CHECK (length(`id`) > 0),
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `owner_json` text NOT NULL CHECK (COALESCE(json_valid(`owner_json`) AND json_type(`owner_json`) = 'object' AND json_extract(`owner_json`, '$.kind') = 'workspace' AND json_type(`owner_json`, '$.workspaceId') = 'text' AND length(json_extract(`owner_json`, '$.workspaceId')) > 0 AND json_type(`owner_json`, '$.userId') IS NULL, 0)),
  `work_id` text NOT NULL CHECK (length(`work_id`) > 0),
  `definition_version` text NOT NULL CHECK (`definition_version` = 'workspace-worker-turn/v1'),
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
  `workspace_id` text NOT NULL REFERENCES `control_workspaces` (`id`),
  `status` text NOT NULL CHECK (`status` IN ('active', 'archived')),
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `revision` integer NOT NULL CHECK (`revision` > 0),
  `record_json` text NOT NULL CHECK (json_valid(`record_json`))
);
--> statement-breakpoint
CREATE TABLE `control_turns` (
  `id` text PRIMARY KEY NOT NULL,
  `thread_id` text NOT NULL REFERENCES `control_threads` (`id`),
  `agent_session_id` text REFERENCES `control_agent_sessions` (`id`),
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
CREATE TABLE `control_workspaces` (
  `id` text PRIMARY KEY NOT NULL,
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `revision` integer NOT NULL CHECK (`revision` > 0),
  `record_json` text NOT NULL CHECK (json_valid(`record_json`))
);
--> statement-breakpoint
CREATE TABLE `evaluation_candidate_sets` (
  `workspace_id` text NOT NULL,
  `candidate_set_id` text NOT NULL,
  `payload_json` text NOT NULL,
  PRIMARY KEY (`workspace_id`, `candidate_set_id`),
  CONSTRAINT `evaluation_candidate_sets_identity_check` CHECK (length(`candidate_set_id`) > 0),
  CONSTRAINT `evaluation_candidate_sets_payload_check` CHECK (json_valid(`payload_json`))
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
, `schema_version` integer DEFAULT 1 NOT NULL);
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
  `observed_at` text NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
  PRIMARY KEY(`workspace_id`, `presentation_id`)
);
--> statement-breakpoint
CREATE TABLE goal_card_tasks (thread_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, card_id TEXT NOT NULL, payload_json TEXT NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL);
--> statement-breakpoint
CREATE TABLE goal_cards (card_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, payload_json TEXT NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL);
--> statement-breakpoint
CREATE TABLE goal_plan_versions (plan_version_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, payload_json TEXT NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL);
--> statement-breakpoint
CREATE TABLE goals (goal_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL);
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
, `schema_version` integer DEFAULT 1 NOT NULL);
--> statement-breakpoint
CREATE TABLE `knowledge_notebook_heads` (
  `workspace_id` text NOT NULL,
  `knowledge_base_id` text PRIMARY KEY NOT NULL,
  `record_json` text NOT NULL,
  CONSTRAINT `knowledge_notebook_heads_json_check` CHECK (json_valid(`record_json`))
);
--> statement-breakpoint
CREATE TABLE `knowledge_notebook_proposals` (
  `workspace_id` text NOT NULL,
  `knowledge_base_id` text NOT NULL,
  `proposal_id` text PRIMARY KEY NOT NULL,
  `record_json` text NOT NULL,
  `reviews_json` text NOT NULL,
  CONSTRAINT `knowledge_notebook_proposals_record_check` CHECK (json_valid(`record_json`)),
  CONSTRAINT `knowledge_notebook_proposals_reviews_check` CHECK (json_valid(`reviews_json`) AND json_type(`reviews_json`) = 'array')
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
, `schema_version` integer DEFAULT 1 NOT NULL, `approved_schema_digest` text);
--> statement-breakpoint
CREATE TABLE "pending_requests" (
  `request_id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `thread_id` text NOT NULL,
  `raising_turn_id` text NOT NULL,
  `request_item_id` text NOT NULL,
  `kind` text NOT NULL,
  `requester_kind` text NOT NULL,
  `agent_id` text,
  `agent_session_id` text,
  `responsible_user_id` text NOT NULL,
  `state` text NOT NULL,
  `resolution` text,
  `deciding_actor_kind` text,
  `deciding_actor_id` text,
	`deciding_actor_context_json` text,
  `decided_at` text,
  `answer_map_json` text,
  `ending` text,
  `invalidating_event` text,
  `ending_actor_kind` text,
  `ending_actor_id` text,
  `ended_at` text,
  `server_id` text,
  `catalog_revision` text,
  `schema_snapshot_id` text,
  `tool_name` text,
  `canonical_arguments_json` text,
  `arguments_digest` text,
  `package_digest` text,
  `policy_decision_id` text,
  `authorization_context_json` text,
  `governed_intent_json` text,
  `questions_json` text,
  `approval_kind` text,
  `title` text,
  `description` text,
  `claim` text NOT NULL,
  `execution_call_id` text,
  `disposition` text,
  `disposition_reason` text,
  `held_result_json` text,
  `publication_turn_id` text,
  `invalidation_turn_id` text,
  `delivery` text NOT NULL,
  `delivery_turn_id` text,
  `delivery_cause` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  assistant_handoff_json text,
  schema_version integer DEFAULT 1 NOT NULL,
  read_goal_id text,
  CONSTRAINT `pending_requests_kind_check` CHECK (`kind` IN ('approval', 'user-input')),
  CONSTRAINT `pending_requests_requester_kind_check` CHECK (`requester_kind` IN ('worker', 'assistant', 'coordinator', 'person', 'automation')),
  CONSTRAINT `pending_requests_state_check` CHECK (`state` IN ('pending', 'resolved', 'ended')),
  CONSTRAINT `pending_requests_resolution_check` CHECK (`resolution` IS NULL OR `resolution` IN ('granted', 'denied', 'answered')),
  CONSTRAINT `pending_requests_deciding_actor_kind_check` CHECK (`deciding_actor_kind` IS NULL OR `deciding_actor_kind` IN ('user', 'system')),
  CONSTRAINT `pending_requests_ending_check` CHECK (`ending` IS NULL OR `ending` IN ('withdrawn', 'invalidated')),
  CONSTRAINT `pending_requests_ending_actor_kind_check` CHECK (`ending_actor_kind` IS NULL OR `ending_actor_kind` IN ('user', 'system')),
  CONSTRAINT `pending_requests_claim_check` CHECK (`claim` IN ('unclaimed', 'claimed', 'finished')),
  CONSTRAINT `pending_requests_disposition_check` CHECK (`disposition` IS NULL OR `disposition` IN ('approved-executed', 'denied-not-executed', 'execution-error', 'outcome-unknown')),
  CONSTRAINT `pending_requests_delivery_check` CHECK (`delivery` IN ('undelivered', 'frozen', 'delivered', 'delivery-unknown', 'closed-out')),
  CONSTRAINT `pending_requests_delivery_cause_check` CHECK (`delivery_cause` IS NULL OR `delivery_cause` IN ('outcome', 'carried')),
  CONSTRAINT `pending_requests_approval_kind_check` CHECK (`approval_kind` IS NULL OR `approval_kind` IN ('permission', 'destructive-action'))
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
	`created_at` text NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
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
, `schema_version` integer DEFAULT 1 NOT NULL);
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
	`updated_at` text NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`workspace_id`,`review_id`)
);
--> statement-breakpoint
CREATE TABLE task_turn_terminal_facts (turn_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload_json TEXT NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL);
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
, `responsible_user_id` text, `schema_version` integer DEFAULT 1 NOT NULL, `provider_model` text);
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
	`updated_at` text NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
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
	`updated_at` text NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
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
	`updated_at` text NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`workspace_id`,`apply_result_id`)
);
--> statement-breakpoint
CREATE TABLE `workspace_capture_records` (
  `capture_id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `state` text NOT NULL,
  `created_at` text NOT NULL,
  `ended_at` text, `origin` text NOT NULL DEFAULT 'manual'
  CHECK (`origin` IN ('manual', 'automatic')),
  CONSTRAINT `workspace_capture_records_state_check`
    CHECK (`state` IN ('active', 'finished', 'abandoned')),
  CONSTRAINT `workspace_capture_records_end_check`
    CHECK ((`state` = 'active' AND `ended_at` IS NULL)
      OR (`state` IN ('finished', 'abandoned') AND `ended_at` IS NOT NULL))
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
	`updated_at` text NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
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
	`updated_at` text NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
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
	`updated_at` text NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
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
	`created_at` text NOT NULL, `judgements` text NOT NULL DEFAULT '[]',
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
	`updated_at` text NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
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
  resolved_at TEXT, `schema_version` integer DEFAULT 1 NOT NULL,
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
	`updated_at` text NOT NULL, `schema_version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`workspace_id`,`reconciliation_record_id`)
);
--> statement-breakpoint
CREATE TABLE workspace_snapshot_collections (
 workspace_id TEXT NOT NULL, storage_ref TEXT NOT NULL, work_slot TEXT NOT NULL,
 collection_id TEXT NOT NULL, identity_json TEXT NOT NULL, result_json TEXT NOT NULL,
 candidate BLOB, is_link INTEGER NOT NULL, change_set_id TEXT, `schema_version` integer DEFAULT 1 NOT NULL,
 PRIMARY KEY (workspace_id, storage_ref, work_slot, collection_id)
);
--> statement-breakpoint
CREATE TABLE workspace_snapshot_cursors (
 workspace_id TEXT NOT NULL, storage_ref TEXT NOT NULL, work_slot TEXT NOT NULL,
 accepted_base_json TEXT, head_json TEXT,
 baseline_identity_json TEXT NOT NULL, accepted_commit TEXT, `schema_version` integer DEFAULT 1 NOT NULL,
 PRIMARY KEY (workspace_id, storage_ref, work_slot)
);
--> statement-breakpoint
CREATE INDEX artifact_reviews_goal_active_idx ON artifact_reviews(workspace_id,read_goal_id,created_at,review_id) WHERE decision IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_reviews_identity_idx` ON `artifact_reviews` (`workspace_id`,`review_id`);
--> statement-breakpoint
CREATE INDEX `artifact_reviews_thread_pending_idx` ON `artifact_reviews` (`workspace_id`,`source_thread_id`,`created_at`,`review_id`) WHERE decision IS NULL;
--> statement-breakpoint
CREATE INDEX `audit_events_capability_call_idx` ON `audit_events` (`capability_call_id`);
--> statement-breakpoint
CREATE INDEX `audit_events_permission_decision_idx` ON `audit_events` (`permission_decision_id`);
--> statement-breakpoint
CREATE INDEX `audit_events_request_idx` ON `audit_events` (`request_id`);
--> statement-breakpoint
CREATE INDEX `audit_events_turn_action_idx` ON `audit_events` (`turn_id`, `action`, `created_at`, `audit_event_id`);
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
CREATE INDEX `capability_calls_turn_family_idx` ON `capability_calls` (`workspace_id`, `thread_id`, `turn_id`, `family`, `started_at`, `call_id`);
--> statement-breakpoint
CREATE INDEX `capability_calls_workspace_idx` ON `capability_calls` (`workspace_id`,`status`,`started_at`);
--> statement-breakpoint
CREATE INDEX `command_receipts_pending_target_idx` ON `idempotency_requests` (coalesce(json_extract(scope_json,'$.approvalRequestId'),json_extract(scope_json,'$.userInputRequestId'),json_extract(scope_json,'$.pendingRequestId')));
--> statement-breakpoint
CREATE UNIQUE INDEX `control_agent_sessions_current_thread_idx` ON `control_agent_sessions` (`thread_id`) WHERE `thread_id` IS NOT NULL AND `status` NOT IN ('closed', 'failed');
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
CREATE INDEX control_items_navigation_completed_idx ON control_product_entries (json_extract(identity_json,'$.threadId'),json_extract(read_metadata_json,'$.completedAt')) WHERE kind='item' AND is_current=1;
--> statement-breakpoint
CREATE INDEX control_items_navigation_created_idx ON control_product_entries (json_extract(identity_json,'$.threadId'),json_extract(read_metadata_json,'$.createdAt')) WHERE kind='item' AND is_current=1;
--> statement-breakpoint
CREATE INDEX `control_items_request_idx` ON `control_product_entries` (json_extract(read_metadata_json,'$.requestId')) WHERE kind='item' AND is_current=1;
--> statement-breakpoint
CREATE INDEX `control_items_thread_actor_idx` ON `control_product_entries` (json_extract(identity_json, '$.threadId'), json_extract(identity_json, '$.actor.id')) WHERE kind='item' AND revision=1;
--> statement-breakpoint
CREATE INDEX `control_items_thread_read_idx` ON `control_product_entries` (json_extract(identity_json,'$.threadId'),json_extract(identity_json,'$.type'),turn_admission_order,item_order) WHERE kind='item' AND is_current=1;
--> statement-breakpoint
CREATE INDEX `control_items_turn_failure_idx` ON `control_product_entries`
  (`turn_id`, json_extract(identity_json,'$.type'))
  WHERE kind='item' AND is_current=1 AND json_extract(read_metadata_json,'$.failed')=1;
--> statement-breakpoint
CREATE INDEX `control_items_turn_history_type_idx` ON `control_product_entries`
  (`turn_id`, json_extract(identity_json,'$.type'), `sequence`)
  WHERE kind='item';
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
CREATE UNIQUE INDEX `control_turns_active_session_idx` ON `control_turns` (`agent_session_id`) WHERE `status` IN ('pending', 'running') AND `agent_session_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `control_turns_active_thread_idx` ON `control_turns` (`thread_id`) WHERE `status` IN ('pending', 'running');
--> statement-breakpoint
CREATE UNIQUE INDEX `control_turns_admission_order_idx` ON `control_turns` (`admission_order`);
--> statement-breakpoint
CREATE INDEX control_turns_navigation_completed_idx ON control_turns (thread_id,json_extract(record_json,'$.completedAt'));
--> statement-breakpoint
CREATE INDEX control_turns_navigation_latest_idx ON control_turns (thread_id,coalesce(json_extract(record_json,'$.startedAt'),''),thread_read_order,id);
--> statement-breakpoint
CREATE INDEX control_turns_navigation_started_idx ON control_turns (thread_id,json_extract(record_json,'$.startedAt'));
--> statement-breakpoint
CREATE INDEX `control_turns_thread_admission_idx` ON `control_turns` (`thread_id`, `admission_order`);
--> statement-breakpoint
CREATE INDEX `control_turns_thread_idx` ON `control_turns` (`thread_id`, `id`);
--> statement-breakpoint
CREATE INDEX `control_turns_thread_read_order_idx` ON `control_turns` (`thread_id`,`thread_read_order`);
--> statement-breakpoint
CREATE INDEX `evidence_bundles_goal_idx` ON `evidence_bundles` (`workspace_id`, `goal_id`);
--> statement-breakpoint
CREATE INDEX `evidence_bundles_status_idx` ON `evidence_bundles` (`import_status`, `retention_class`);
--> statement-breakpoint
CREATE INDEX `evidence_bundles_thread_idx` ON `evidence_bundles` (`workspace_id`, `thread_id`, `turn_id`);
--> statement-breakpoint
CREATE INDEX `evidence_bundles_workspace_idx` ON `evidence_bundles` (`workspace_id`, `created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `generative_presentations_request_idx`
ON `generative_presentations` (`workspace_id`, `request_id`)
WHERE `request_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `generative_presentations_thread_idx`
ON `generative_presentations` (`workspace_id`, `thread_id`, `created_at`, `presentation_id`);
--> statement-breakpoint
CREATE INDEX goal_cards_goal ON goal_cards(goal_id);
--> statement-breakpoint
CREATE INDEX goal_tasks_goal ON goal_card_tasks(goal_id);
--> statement-breakpoint
CREATE INDEX goal_versions_goal ON goal_plan_versions(goal_id);
--> statement-breakpoint
CREATE INDEX idx_workspace_quarantine_records_workspace_resolution_created
  ON workspace_quarantine_records (workspace_id, resolution, created_at, quarantine_record_id);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_tool_schema_snapshots_digest_idx` ON `mcp_tool_schema_snapshots` (`workspace_id`,`catalog_entry_id`,`source`,`content_digest`);
--> statement-breakpoint
CREATE INDEX `mcp_tool_schema_snapshots_workspace_idx` ON `mcp_tool_schema_snapshots` (`workspace_id`,`catalog_entry_id`,`captured_at`);
--> statement-breakpoint
CREATE INDEX pending_requests_goal_active_idx ON pending_requests(workspace_id,read_goal_id,created_at,request_id) WHERE state='pending';
--> statement-breakpoint
CREATE INDEX `pending_requests_thread_active_idx` ON `pending_requests` (`workspace_id`,`thread_id`,`created_at`,`request_id`) WHERE state='pending';
--> statement-breakpoint
CREATE INDEX `pending_requests_thread_state_idx` ON `pending_requests` (`workspace_id`, `thread_id`, `state`);
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
CREATE INDEX `runtime_evidence_turn_latest_idx` ON `runtime_evidence` (`workspace_id`,`thread_id`,`turn_id`,`created_at`,`runtime_evidence_id`);
--> statement-breakpoint
CREATE INDEX `runtime_evidence_workspace_idx` ON `runtime_evidence` (`workspace_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX staged_workspace_reviews_artifact_idx ON staged_workspace_reviews(workspace_id,artifact_id);
--> statement-breakpoint
CREATE INDEX `staged_workspace_reviews_change_set_idx` ON `staged_workspace_reviews` (`workspace_id`,`change_set_id`,`updated_at`,`review_id`);
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
CREATE UNIQUE INDEX workspace_snapshot_collection_review_idx ON workspace_snapshot_collections(workspace_id, change_set_id) WHERE change_set_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER artifact_reviews_goal_scope_insert AFTER INSERT ON artifact_reviews BEGIN
UPDATE artifact_reviews SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=NEW.source_thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=NEW.source_thread_id LIMIT 1) WHERE review_id=NEW.review_id;
END;
--> statement-breakpoint
CREATE TRIGGER artifact_reviews_goal_scope_update AFTER UPDATE OF source_thread_id ON artifact_reviews BEGIN
UPDATE artifact_reviews SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=NEW.source_thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=NEW.source_thread_id LIMIT 1) WHERE review_id=NEW.review_id;
END;
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
CREATE TRIGGER goal_card_tasks_attention_scope_delete AFTER DELETE ON goal_card_tasks BEGIN
UPDATE pending_requests SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=pending_requests.thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=pending_requests.thread_id LIMIT 1) WHERE thread_id=OLD.thread_id;
UPDATE artifact_reviews SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=artifact_reviews.source_thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=artifact_reviews.source_thread_id LIMIT 1) WHERE source_thread_id=OLD.thread_id;
END;
--> statement-breakpoint
CREATE TRIGGER goal_card_tasks_attention_scope_insert AFTER INSERT ON goal_card_tasks BEGIN
UPDATE pending_requests SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=pending_requests.thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=pending_requests.thread_id LIMIT 1) WHERE thread_id=NEW.thread_id;
UPDATE artifact_reviews SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=artifact_reviews.source_thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=artifact_reviews.source_thread_id LIMIT 1) WHERE source_thread_id=NEW.thread_id;
END;
--> statement-breakpoint
CREATE TRIGGER goals_attention_scope_delete AFTER DELETE ON goals BEGIN
UPDATE pending_requests SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=pending_requests.thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=pending_requests.thread_id LIMIT 1) WHERE thread_id=OLD.thread_id;
UPDATE artifact_reviews SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=artifact_reviews.source_thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=artifact_reviews.source_thread_id LIMIT 1) WHERE source_thread_id=OLD.thread_id;
END;
--> statement-breakpoint
CREATE TRIGGER goals_attention_scope_insert AFTER INSERT ON goals BEGIN
UPDATE pending_requests SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=pending_requests.thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=pending_requests.thread_id LIMIT 1) WHERE thread_id=NEW.thread_id;
UPDATE artifact_reviews SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=artifact_reviews.source_thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=artifact_reviews.source_thread_id LIMIT 1) WHERE source_thread_id=NEW.thread_id;
END;
--> statement-breakpoint
CREATE TRIGGER pending_requests_goal_scope_insert AFTER INSERT ON pending_requests BEGIN
UPDATE pending_requests SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=NEW.thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=NEW.thread_id LIMIT 1) WHERE request_id=NEW.request_id;
END;
--> statement-breakpoint
CREATE TRIGGER pending_requests_goal_scope_update AFTER UPDATE OF thread_id ON pending_requests BEGIN
UPDATE pending_requests SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=NEW.thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=NEW.thread_id LIMIT 1) WHERE request_id=NEW.request_id;
END;
