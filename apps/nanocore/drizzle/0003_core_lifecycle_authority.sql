ALTER TABLE `users`
ADD COLUMN `status` text DEFAULT 'active' NOT NULL
CHECK (`status` IN ('active', 'disabled'));
--> statement-breakpoint
ALTER TABLE `users`
ADD COLUMN `disabled_at` text;
--> statement-breakpoint
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
ALTER TABLE `audit_events`
ADD COLUMN `actor_json` text;
--> statement-breakpoint
ALTER TABLE `audit_events`
ADD COLUMN `subject_json` text;
--> statement-breakpoint
ALTER TABLE `audit_events`
ADD COLUMN `resource_revision` integer
CHECK (`resource_revision` IS NULL OR (typeof(`resource_revision`) = 'integer' AND `resource_revision` > 0));
