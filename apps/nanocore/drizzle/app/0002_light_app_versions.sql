ALTER TABLE `app_metadata` ADD COLUMN `kernel_format_version` integer NOT NULL DEFAULT 2 CHECK (`kernel_format_version` = 2);
--> statement-breakpoint
ALTER TABLE `app_metadata` ADD COLUMN `definition_source_json` text;
