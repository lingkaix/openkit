-- Version independently decoded JSON payloads; scalar-only rows keep the native journal.
ALTER TABLE `audit_events` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `idempotency_requests` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `thread_read_receipts` ADD `schema_version` integer DEFAULT 1 NOT NULL;
