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
  `expires_at` text NOT NULL,
  `schema_version` integer DEFAULT 1 NOT NULL
);

--> statement-breakpoint

CREATE TABLE `thread_read_receipts` (
  `workspace_id` text NOT NULL,
  `thread_id` text NOT NULL,
  `item_ids_json` text NOT NULL,
  `schema_version` integer DEFAULT 1 NOT NULL,
  PRIMARY KEY (`workspace_id`, `thread_id`)
);

--> statement-breakpoint

-- Reuse the existing AuditEvent family in the original User database; Memory ownership does not move.
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
	`occurred_at` text NOT NULL,
	`permission_decision_id` text,
	`vault_grant_id` text,
	`actor_json` text,
	`subject_json` text,
	`resource_revision` integer,
	`notebook_admission_json` text,
	`schema_version` integer NOT NULL,
	`policy_invocation_json` text,
	`policy_write_outcome_json` text,
	`authentication_json` text,
	CHECK (`workspace_id` IS NULL),
	CHECK (`resource_revision` IS NULL OR (typeof(`resource_revision`) = 'integer' AND `resource_revision` > 0))
);

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

CREATE TABLE `permission_decisions` (
	`decision_id` text PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
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
	`mediation_json` text,
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

CREATE UNIQUE INDEX `permission_decisions_terminal_approval_idx` ON `permission_decisions` (`approval_id`) WHERE `owner_scope` = 'user' AND `approval_id` IS NOT NULL AND `result` IN ('allow', 'deny');
