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
	CONSTRAINT `capability_calls_system_prompt_digest_check` CHECK (`system_prompt_digest` IS NULL OR `family` = 'llm')
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
CREATE UNIQUE INDEX `capability_calls_idempotency_idx` ON `capability_calls` (`request_id`,`family`,`operation`);
--> statement-breakpoint
CREATE INDEX `capability_calls_thread_idx` ON `capability_calls` (`thread_id`,`turn_id`,`started_at`);
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
CREATE INDEX `evidence_bundles_status_idx` ON `evidence_bundles` (`import_status`,`retention_class`);
--> statement-breakpoint
CREATE INDEX `evidence_bundles_thread_idx` ON `evidence_bundles` (`thread_id`,`turn_id`);
--> statement-breakpoint
CREATE INDEX `usage_records_capability_call_idx` ON `usage_records` (`capability_call_id`);
--> statement-breakpoint
CREATE INDEX `usage_records_thread_idx` ON `usage_records` (`thread_id`,`turn_id`,`recorded_at`);
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
