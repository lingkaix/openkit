CREATE TABLE notification_attention (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('approval-request', 'user-input-request')),
  request_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  channel TEXT CHECK (channel IN ('discord', 'email')),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, thread_id, source_kind, request_id, recipient_user_id)
);
CREATE INDEX notification_attention_recipient ON notification_attention (recipient_user_id, created_at DESC, id DESC);
CREATE TABLE notification_delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attention_id TEXT NOT NULL REFERENCES notification_attention(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('discord', 'email')),
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed-no-send', 'delivery-unknown')),
  failure_code TEXT CHECK (failure_code IN ('authority-unavailable', 'transport-refused', 'transport-unknown', 'restart')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK ((status = 'sending' AND finished_at IS NULL AND failure_code IS NULL)
    OR (status = 'sent' AND finished_at IS NOT NULL AND failure_code IS NULL)
    OR (status = 'failed-no-send' AND finished_at IS NOT NULL AND failure_code IN ('authority-unavailable', 'transport-refused'))
    OR (status = 'delivery-unknown' AND finished_at IS NOT NULL AND failure_code IN ('transport-unknown', 'restart')))
);
CREATE INDEX notification_attempt_attention ON notification_delivery_attempts (attention_id, id DESC);
CREATE UNIQUE INDEX notification_one_active_attempt ON notification_delivery_attempts (attention_id) WHERE status = 'sending';
CREATE TABLE discord_pairing_challenges (
  digest TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE TABLE discord_account_bindings (
  discord_user_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX discord_account_bindings_active_user ON discord_account_bindings(user_id) WHERE revoked_at IS NULL;
CREATE TABLE discord_inbound_receipts (
  event_id TEXT PRIMARY KEY NOT NULL,
  payload_digest TEXT NOT NULL,
  request_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('dispatching','settled','response-unknown')),
  created_at INTEGER NOT NULL
);
CREATE TABLE discord_disclosures (
  token_digest TEXT PRIMARY KEY NOT NULL,
  discord_user_id TEXT NOT NULL,
  binding_revision TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  pending_request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('approval','user-input')),
  content_digest TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

