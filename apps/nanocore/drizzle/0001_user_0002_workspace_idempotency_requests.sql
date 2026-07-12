CREATE TABLE IF NOT EXISTS `idempotency_requests` (
  `request_key` text PRIMARY KEY NOT NULL,
  `command_name` text NOT NULL,
  `request_id` text NOT NULL,
  `scope_json` text NOT NULL,
  `input_hash` text NOT NULL,
  `response_kind` text NOT NULL,
  `response_id` text NOT NULL,
  `created_at` text NOT NULL,
  `expires_at` text NOT NULL
);
