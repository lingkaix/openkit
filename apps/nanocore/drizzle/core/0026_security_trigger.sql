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
INSERT INTO `security_trigger_state` (`singleton`) VALUES (1);
--> statement-breakpoint
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
CREATE UNIQUE INDEX `security_trigger_alarm_generation_rule` ON `security_trigger_alarms` (`enable_generation`, `rule`);
--> statement-breakpoint
CREATE TABLE `security_trigger_outbox` (
  `request_id` text PRIMARY KEY NOT NULL,
  `schema_version` integer DEFAULT 1 NOT NULL,
  `alarm_id` text REFERENCES `security_trigger_alarms` (`id`),
  `key_json` text NOT NULL,
  `recipient_user_id` text NOT NULL,
  `occurrence_kind` text NOT NULL CHECK (`occurrence_kind` IN ('initial','reopen','reminder','renotice','conflict')),
  `occurrence_n` integer NOT NULL CHECK (`occurrence_n` BETWEEN 1 AND 9007199254740991),
  `raised` integer DEFAULT 0 NOT NULL CHECK (`raised` IN (0,1)),
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_trigger_outbox_occurrence` ON `security_trigger_outbox` (`key_json`, `recipient_user_id`, `occurrence_kind`, `occurrence_n`);
--> statement-breakpoint
CREATE INDEX `security_trigger_outbox_alarm` ON `security_trigger_outbox` (`alarm_id`);
--> statement-breakpoint
CREATE INDEX `security_trigger_outbox_pending` ON `security_trigger_outbox` (`raised`, `created_at`, `request_id`);
