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
CREATE UNIQUE INDEX `security_thread_destination_thread` ON `security_thread_destinations` (`thread_id`);
