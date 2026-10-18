-- The Core database supplies the Server owner of the existing record families.
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
	`extensions_json` text,
	CONSTRAINT `capability_calls_system_prompt_digest_check` CHECK (`system_prompt_digest` IS NULL OR (`family` = 'llm' AND `capability_id` IN ('llm.chat_completions', 'llm.responses')))
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
, `responsible_user_id` text);

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
);

--> statement-breakpoint

CREATE UNIQUE INDEX `capability_calls_idempotency_idx` ON `capability_calls` (`request_id`,`family`,`operation`);

--> statement-breakpoint

CREATE INDEX `capability_calls_thread_idx` ON `capability_calls` (`thread_id`,`turn_id`,`started_at`);

--> statement-breakpoint

CREATE INDEX `usage_records_capability_call_idx` ON `usage_records` (`capability_call_id`);

--> statement-breakpoint

CREATE INDEX `usage_records_thread_idx` ON `usage_records` (`thread_id`,`turn_id`,`recorded_at`);

--> statement-breakpoint

CREATE INDEX `evidence_bundles_thread_idx` ON `evidence_bundles` (`thread_id`,`turn_id`);

--> statement-breakpoint

CREATE INDEX `evidence_bundles_status_idx` ON `evidence_bundles` (`import_status`,`retention_class`);
