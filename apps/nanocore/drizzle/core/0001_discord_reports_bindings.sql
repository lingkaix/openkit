CREATE TABLE `discord_reports_bindings` (
  `binding_id` text PRIMARY KEY NOT NULL,
  `binding_revision` text NOT NULL UNIQUE,
  `guild_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `bot_user_id` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('draft', 'active', 'revoked')),
  `target_json` text NOT NULL CHECK (json_valid(`target_json`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discord_reports_active_route` ON `discord_reports_bindings` (`guild_id`, `channel_id`, `bot_user_id`) WHERE `state` = 'active';
--> statement-breakpoint
CREATE TABLE `discord_reports_binding_revisions` (
  `binding_id` text NOT NULL REFERENCES `discord_reports_bindings` (`binding_id`),
  `binding_revision` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('draft', 'active', 'revoked')),
  `target_json` text NOT NULL CHECK (json_valid(`target_json`)),
  PRIMARY KEY (`binding_id`, `binding_revision`)
);
--> statement-breakpoint
CREATE TABLE `discord_reports_participants` (
  `binding_id` text NOT NULL REFERENCES `discord_reports_bindings` (`binding_id`),
  `discord_user_id` text NOT NULL,
  `principal_id` text NOT NULL UNIQUE,
  `tier` text NOT NULL CHECK (`tier` IN ('basic', 'expanded')),
  `tier_revision` text NOT NULL UNIQUE,
  PRIMARY KEY (`binding_id`, `discord_user_id`)
);
