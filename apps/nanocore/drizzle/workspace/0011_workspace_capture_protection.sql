CREATE TABLE `workspace_capture_records` (
  `capture_id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `state` text NOT NULL,
  `created_at` text NOT NULL,
  `ended_at` text,
  CONSTRAINT `workspace_capture_records_state_check`
    CHECK (`state` IN ('active', 'finished', 'abandoned')),
  CONSTRAINT `workspace_capture_records_end_check`
    CHECK ((`state` = 'active' AND `ended_at` IS NULL)
      OR (`state` IN ('finished', 'abandoned') AND `ended_at` IS NOT NULL))
);
