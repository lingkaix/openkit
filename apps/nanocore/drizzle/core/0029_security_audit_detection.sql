CREATE TABLE `security_trigger_audit_progress` (
  `singleton` integer PRIMARY KEY NOT NULL CHECK (`singleton` = 1),
  `schema_version` integer DEFAULT 1 NOT NULL,
  `cursor_rowid` integer,
  `cursor_created_at` text,
  `cursor_audit_event_id` text,
  `assessed_count` integer DEFAULT 0 NOT NULL CHECK (`assessed_count` BETWEEN 0 AND 9007199254740991),
  CHECK ((`cursor_rowid` IS NULL AND `cursor_created_at` IS NULL AND `cursor_audit_event_id` IS NULL AND `assessed_count` = 0)
    OR (`cursor_rowid` IS NOT NULL AND `cursor_rowid` BETWEEN 1 AND 9007199254740991 AND `cursor_created_at` IS NOT NULL AND `cursor_audit_event_id` IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `security_trigger_audit_progress` (`singleton`) VALUES (1);
--> statement-breakpoint
CREATE TABLE `security_trigger_audit_assessments` (
  `audit_event_id` text PRIMARY KEY NOT NULL,
  `schema_version` integer DEFAULT 1 NOT NULL,
  `source_rowid` integer NOT NULL CHECK (`source_rowid` BETWEEN 1 AND 9007199254740991),
  `created_at` text NOT NULL,
  `enable_generation` integer NOT NULL CHECK (`enable_generation` > 0),
  `action` text NOT NULL,
  `actor_json` text,
  `target_user_id` text,
  `outcome` text NOT NULL CHECK (`outcome` IN ('succeeded','failed','denied','cancelled','unknown')),
  `responsible_user_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('detected','unsupported')),
  `rule` text CHECK (`rule` IN ('R1','R1d')),
  `notify` text CHECK (`notify` IN ('immediate','daily')),
  `missing_fields_json` text NOT NULL,
  `recipient_count` integer NOT NULL CHECK (`recipient_count` BETWEEN 0 AND 9007199254740991),
  CHECK ((`status` = 'unsupported' AND `rule` IS NULL AND `notify` IS NULL AND `recipient_count` = 0)
    OR (`status` = 'detected' AND `rule` IS NOT NULL AND `notify` IS NOT NULL AND `recipient_count` > 0)),
  CHECK (`rule` IS NULL OR `rule` <> 'R1d' OR `recipient_count` = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_trigger_assessment_source` ON `security_trigger_audit_assessments` (`source_rowid`);
--> statement-breakpoint
CREATE INDEX `security_trigger_assessment_page` ON `security_trigger_audit_assessments` (`created_at`,`audit_event_id`);
--> statement-breakpoint
ALTER TABLE `security_trigger_outbox` ADD COLUMN `audit_event_id` text REFERENCES `security_trigger_audit_assessments` (`audit_event_id`);
--> statement-breakpoint
CREATE INDEX `security_trigger_outbox_event` ON `security_trigger_outbox` (`audit_event_id`);
