CREATE INDEX `capability_calls_turn_family_idx` ON `capability_calls` (`workspace_id`, `thread_id`, `turn_id`, `family`, `started_at`, `call_id`);
