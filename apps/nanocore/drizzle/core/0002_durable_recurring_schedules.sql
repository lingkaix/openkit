CREATE TABLE IF NOT EXISTS recurring_schedules (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  responsible_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('paused', 'active', 'deleted')),
  revision INTEGER NOT NULL,
  next_scheduled_at INTEGER,
  record_json TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS recurring_schedules_due_idx
  ON recurring_schedules(status, next_scheduled_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS recurring_occurrences (
  id TEXT PRIMARY KEY NOT NULL,
  schedule_id TEXT NOT NULL REFERENCES recurring_schedules(id),
  workspace_id TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'admission-accepted', 'admission-failed', 'expired', 'cancelled', 'recovery_required')),
  queue_entry_id TEXT UNIQUE,
  record_json TEXT NOT NULL,
  UNIQUE(schedule_id, scheduled_at)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS recurring_occurrences_pending_idx
  ON recurring_occurrences(state, deadline);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS recurring_occurrences_history_idx
  ON recurring_occurrences(schedule_id, scheduled_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS recurring_expired_ranges (
  id TEXT PRIMARY KEY NOT NULL,
  schedule_id TEXT NOT NULL REFERENCES recurring_schedules(id),
  workspace_id TEXT NOT NULL,
  definition_revision INTEGER NOT NULL,
  first_scheduled_at INTEGER NOT NULL,
  last_scheduled_at INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  UNIQUE(schedule_id, first_scheduled_at)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS recurring_expired_ranges_history_idx
  ON recurring_expired_ranges(schedule_id, first_scheduled_at);
