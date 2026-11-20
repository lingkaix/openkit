CREATE TABLE channel_account_bindings (
  revision TEXT PRIMARY KEY NOT NULL,
  channel_kind TEXT NOT NULL CHECK (channel_kind = 'discord'),
  external_account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  revoked_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX channel_bindings_active_account
  ON channel_account_bindings(channel_kind, external_account_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX channel_bindings_active_user
  ON channel_account_bindings(channel_kind, user_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE TABLE channel_pairing_challenges (
  digest TEXT PRIMARY KEY NOT NULL,
  channel_kind TEXT NOT NULL CHECK (channel_kind = 'discord'),
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
--> statement-breakpoint
CREATE INDEX channel_pairing_open_user
  ON channel_pairing_challenges(channel_kind, user_id) WHERE consumed_at IS NULL;
--> statement-breakpoint
CREATE TABLE channel_disclosures (
  token_digest TEXT PRIMARY KEY NOT NULL,
  channel_kind TEXT NOT NULL CHECK (channel_kind = 'discord'),
  external_account_id TEXT NOT NULL,
  binding_revision TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  pending_request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('approval', 'user-input')),
  content_digest TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE notification_attention (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('approval-request', 'user-input-request', 'security-notice')),
  request_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  channel TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, thread_id, source_kind, request_id, recipient_user_id)
);
--> statement-breakpoint
CREATE INDEX notification_attention_recipient
  ON notification_attention(recipient_user_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE TABLE notification_delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attention_id TEXT NOT NULL REFERENCES notification_attention(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed-no-send', 'delivery-unknown')),
  failure_code TEXT CHECK (failure_code IN ('authority-unavailable', 'transport-refused', 'transport-unknown', 'restart')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK ((status = 'sending' AND finished_at IS NULL AND failure_code IS NULL)
    OR (status = 'sent' AND finished_at IS NOT NULL AND failure_code IS NULL)
    OR (status = 'failed-no-send' AND finished_at IS NOT NULL AND failure_code IS NOT NULL AND failure_code IN ('authority-unavailable', 'transport-refused'))
    OR (status = 'delivery-unknown' AND finished_at IS NOT NULL AND failure_code IS NOT NULL AND failure_code IN ('transport-unknown', 'restart')))
);
--> statement-breakpoint
CREATE INDEX notification_attempt_attention
  ON notification_delivery_attempts(attention_id, id DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX notification_one_active_attempt
  ON notification_delivery_attempts(attention_id) WHERE status = 'sending';
--> statement-breakpoint
CREATE TABLE communication_intents (
  sequence INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
  receipt_digest TEXT
);
--> statement-breakpoint
CREATE INDEX communication_pairing_audit_pending
  ON communication_intents(sequence) WHERE receipt_digest IS NULL;
