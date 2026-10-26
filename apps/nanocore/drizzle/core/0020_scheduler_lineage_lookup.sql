CREATE INDEX `scheduler_execution_attempts_lineage_idx` ON `scheduler_execution_attempts` (`workspace_id`, `thread_id`, `turn_id`, `agent_session_id`, `input_ref`);
