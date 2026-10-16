/** Core migration DDL for attention references and their sole delivery-attempt authority. */
export const ATTENTION_SCHEMA_SQL = `
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
`;
