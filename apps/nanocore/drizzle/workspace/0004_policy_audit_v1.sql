ALTER TABLE `audit_events` ADD `schema_version` integer NOT NULL;
--> statement-breakpoint
ALTER TABLE `permission_decisions` ADD `schema_version` integer NOT NULL;
--> statement-breakpoint
ALTER TABLE `audit_events` ADD `policy_invocation_json` text;
--> statement-breakpoint
ALTER TABLE `audit_events` ADD `policy_write_outcome_json` text;
--> statement-breakpoint
ALTER TABLE `permission_decisions` ADD `mediation_json` text;
