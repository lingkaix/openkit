CREATE TABLE `discord_reports_ambient_revisions` (
  `revision_id` text PRIMARY KEY NOT NULL,
  `guild_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `message_id` text NOT NULL,
  `content_digest` text NOT NULL,
  `edited_at` text,
  `source_author_ref` text NOT NULL,
  `created_at` integer NOT NULL,
  `posted_at` integer NOT NULL,
  `body` text,
  `blocked` integer NOT NULL DEFAULT 0 CHECK (`blocked` IN (0,1)),
  CHECK (`created_at` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discord_reports_ambient_revision_key` ON `discord_reports_ambient_revisions` (`guild_id`,`channel_id`,`message_id`,`content_digest`,coalesce(`edited_at`,''));
--> statement-breakpoint
CREATE TABLE `discord_reports_ambient_captures` (
  `turn_id` text PRIMARY KEY NOT NULL,
  `binding_revision` text NOT NULL,
  `capture_item_id` text NOT NULL UNIQUE,
  `tier` text NOT NULL CHECK (`tier` IN ('basic','expanded')),
  `mention_id` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('selected','unavailable','blocked')),
  `capture_digest` text,
  `count_observed_at` integer,
  `approximate_member_count` integer,
  `window_start` integer,
  `captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `discord_reports_ambient_refs` (
  `turn_id` text NOT NULL REFERENCES `discord_reports_ambient_captures` (`turn_id`),
  `ordinal` integer NOT NULL,
  `revision_id` text NOT NULL REFERENCES `discord_reports_ambient_revisions` (`revision_id`),
  `author_ref` text NOT NULL,
  `rendered_label` text NOT NULL,
  PRIMARY KEY (`turn_id`,`ordinal`),
  UNIQUE (`turn_id`,`revision_id`)
);
--> statement-breakpoint
CREATE INDEX `discord_reports_ambient_reverse_refs` ON `discord_reports_ambient_refs` (`revision_id`);
