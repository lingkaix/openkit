ALTER TABLE `workspace_capture_records`
  ADD COLUMN `origin` text NOT NULL DEFAULT 'manual'
  CHECK (`origin` IN ('manual', 'automatic'));
