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

CREATE TABLE `app_metadata` (
  `app_id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `title` text NOT NULL,
  `purpose` text NOT NULL,
  `app_revision` integer NOT NULL,
  `schema_revision` integer NOT NULL,
  `schema_digest` text NOT NULL,
  `schema_json` text NOT NULL,
  `lifecycle` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `creator_json` text NOT NULL,
  `last_mutator_json` text NOT NULL,
  `create_request_id` text NOT NULL,
  `last_request_id` text NOT NULL,
  CHECK (`lifecycle` IN ('active', 'retired')),
  CHECK (typeof(`app_revision`) = 'integer' AND `app_revision` > 0),
  CHECK (typeof(`schema_revision`) = 'integer' AND `schema_revision` > 0)
);
