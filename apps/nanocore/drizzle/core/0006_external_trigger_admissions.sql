CREATE TABLE external_trigger_admissions (
  schedule_id TEXT NOT NULL REFERENCES recurring_schedules(id),
  event_key TEXT NOT NULL CONSTRAINT external_trigger_admissions_event_key_check CHECK (length(event_key) BETWEEN 1 AND 1024),
  source_turn_id TEXT NOT NULL,
  queue_entry_id TEXT NOT NULL REFERENCES scheduler_admission_entries(queue_entry_id),
  PRIMARY KEY (schedule_id, event_key)
);
