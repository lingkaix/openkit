-- Version independently decoded JSON payloads; scalar-only rows keep the native journal.
ALTER TABLE `agent_session_runtime_bindings` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `audit_events` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `boot_audit_events` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `capability_calls` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `evidence_bundles` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `harness_instance_records` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `idempotency_requests` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `openkit_access_tokens` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `permission_decisions` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `recurring_expired_ranges` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `recurring_occurrences` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `recurring_schedules` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `scheduler_admission_entries` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `scheduler_execution_attempts` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `server_settings` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `usage_records` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `worker_backend_sessions` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `worker_control_records` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `worker_image_settlements` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `worker_storage_bindings` ADD `schema_version` integer DEFAULT 1 NOT NULL;

--> statement-breakpoint
ALTER TABLE vault_grants ADD schema_version integer DEFAULT 1 NOT NULL;
