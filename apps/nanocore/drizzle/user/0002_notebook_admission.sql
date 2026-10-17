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
	`occurred_at` text NOT NULL
, `permission_decision_id` text, `vault_grant_id` text, `actor_json` text, `subject_json` text, `resource_revision` integer,
`notebook_admission_json` text,
CHECK (`workspace_id` IS NULL),
CHECK (`resource_revision` IS NULL OR (typeof(`resource_revision`) = 'integer' AND `resource_revision` > 0)));

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
