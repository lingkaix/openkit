ALTER TABLE `audit_events` ADD `schema_version` integer NOT NULL;
--> statement-breakpoint
ALTER TABLE `permission_decisions` ADD `schema_version` integer NOT NULL;
