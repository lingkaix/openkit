CREATE TABLE `security_trigger_alarms` (
  `id` text PRIMARY KEY NOT NULL,
  `schema_version` integer DEFAULT 1 NOT NULL,
  `enable_generation` integer NOT NULL CHECK (`enable_generation` BETWEEN 1 AND 9007199254740991),
  `rule` text NOT NULL CHECK (`rule` IN ('R1','R8')),
  `recipient_count` integer NOT NULL CHECK (`recipient_count` >= 0),
  `failure` text CHECK (`failure` IS NULL OR `failure` = 'no-current-administrator'),
  `created_at` text NOT NULL,
  CHECK ((`recipient_count` = 0 AND `failure` IS NOT NULL AND `failure` = 'no-current-administrator') OR (`recipient_count` > 0 AND `failure` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `security_trigger_audit_progress` (
  `singleton` integer PRIMARY KEY NOT NULL CHECK (`singleton` = 1),
  `schema_version` integer DEFAULT 1 NOT NULL,
  `cursor_rowid` integer,
  `cursor_created_at` text,
  `cursor_audit_event_id` text,
  `assessed_count` integer DEFAULT 0 NOT NULL CHECK (`assessed_count` BETWEEN 0 AND 9007199254740991),
  CHECK ((`cursor_rowid` IS NULL AND `cursor_created_at` IS NULL AND `cursor_audit_event_id` IS NULL)
    OR (`cursor_rowid` IS NOT NULL AND `cursor_rowid` BETWEEN 1 AND 9007199254740991 AND `cursor_created_at` IS NOT NULL AND `cursor_audit_event_id` IS NOT NULL))
);
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
  `rule` text CHECK (`rule` IN ('R1','R1d','E12')),
  `notify` text CHECK (`notify` IN ('immediate','daily')),
  `missing_fields_json` text NOT NULL,
  `recipient_count` integer NOT NULL CHECK (`recipient_count` BETWEEN 0 AND 9007199254740991),
  CHECK ((`status` = 'unsupported' AND `rule` IS NULL AND `notify` IS NULL AND `recipient_count` = 0)
    OR (`status` = 'detected' AND `rule` IS NOT NULL AND `notify` IS NOT NULL AND (`recipient_count` > 0 OR `rule` = 'E12'))),
  CHECK (`rule` IS NULL OR `rule` <> 'R1d' OR `recipient_count` = 1)
);
--> statement-breakpoint
CREATE TABLE `security_trigger_outbox` (
  `request_id` text PRIMARY KEY NOT NULL,
  `schema_version` integer DEFAULT 1 NOT NULL,
  `alarm_id` text REFERENCES `security_trigger_alarms` (`id`),
  `audit_event_id` text REFERENCES `security_trigger_audit_assessments` (`audit_event_id`),
  `key_json` text NOT NULL,
  `recipient_user_id` text NOT NULL,
  `occurrence_kind` text NOT NULL CHECK (`occurrence_kind` IN ('initial','reopen','reminder','renotice','conflict')),
  `occurrence_n` integer NOT NULL CHECK (`occurrence_n` BETWEEN 1 AND 9007199254740991),
  `raised` integer DEFAULT 0 NOT NULL CHECK (`raised` IN (0,1)),
  `command_receipt` text,
  `created_at` text NOT NULL,
  CHECK ((`raised` = 0 AND `command_receipt` IS NULL) OR (`raised` = 1 AND `command_receipt` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `security_thread_destinations` (
  `schema_version` integer DEFAULT 1 NOT NULL,
  `recipient_user_id` text NOT NULL,
  `generation` integer NOT NULL CHECK (`generation` BETWEEN 1 AND 9007199254740991),
  `workspace_id` text NOT NULL,
  `thread_id` text NOT NULL,
  `source_request_id` text NOT NULL REFERENCES `security_trigger_outbox` (`request_id`),
  `status` text NOT NULL CHECK (`status` IN ('reserved','ready')),
  `created_at` text NOT NULL,
  PRIMARY KEY (`recipient_user_id`, `generation`)
);
--> statement-breakpoint
CREATE TABLE `security_trigger_state` (
  `singleton` integer PRIMARY KEY NOT NULL CHECK (`singleton` = 1),
  `schema_version` integer DEFAULT 1 NOT NULL,
  `state` text DEFAULT 'off' NOT NULL CHECK (`state` IN ('off','on','stopping')),
  `enable_generation` integer DEFAULT 0 NOT NULL CHECK (`enable_generation` BETWEEN 0 AND 9007199254740991),
  `enabling_user_id` text,
  `expected_alarm_count` integer DEFAULT 0 NOT NULL CHECK (`expected_alarm_count` BETWEEN 0 AND 2),
  CHECK (`state` = 'off' OR (`enabling_user_id` IS NOT NULL AND `enable_generation` > 0)),
  CHECK (`state` != 'on' OR `expected_alarm_count` = 0),
  CHECK (`state` != 'stopping' OR `expected_alarm_count` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_thread_destination_thread` ON `security_thread_destinations` (`thread_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_trigger_alarm_generation_rule` ON `security_trigger_alarms` (`enable_generation`, `rule`);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_trigger_assessment_source` ON `security_trigger_audit_assessments` (`source_rowid`);
--> statement-breakpoint
CREATE INDEX `security_trigger_assessment_page` ON `security_trigger_audit_assessments` (`created_at`,`audit_event_id`);
--> statement-breakpoint
CREATE INDEX `security_trigger_outbox_event` ON `security_trigger_outbox` (`audit_event_id`);
--> statement-breakpoint
CREATE INDEX `security_trigger_outbox_alarm` ON `security_trigger_outbox` (`alarm_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_trigger_outbox_occurrence` ON `security_trigger_outbox` (`key_json`, `recipient_user_id`, `occurrence_kind`, `occurrence_n`);
--> statement-breakpoint
CREATE INDEX `security_trigger_outbox_pending` ON `security_trigger_outbox` (`raised`, `created_at`, `request_id`);
--> statement-breakpoint
INSERT INTO `security_trigger_state` (`singleton`) VALUES (1);
--> statement-breakpoint
INSERT INTO `security_trigger_audit_progress` (`singleton`) VALUES (1);
