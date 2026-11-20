CREATE TABLE `discord_reports_delivery` (
  `origin_id` text PRIMARY KEY NOT NULL,
  `attempt_id` text NOT NULL UNIQUE,
  `action_digest` text NOT NULL,
  `permission_decision_id` text NOT NULL,
  `approval_request_id` text,
  `guild_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `bot_user_id` text NOT NULL,
  `posted_digest` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('claimed', 'sent', 'failed-no-send', 'delivery-unknown')),
  `discord_message_id` text,
  `posted_body_ref` text,
  `acknowledged_at` integer,
  CHECK ((`state` = 'sent' AND `discord_message_id` IS NOT NULL AND `acknowledged_at` IS NOT NULL)
    OR (`state` <> 'sent' AND `discord_message_id` IS NULL AND `posted_body_ref` IS NULL AND `acknowledged_at` IS NULL))
);
