DROP INDEX `control_agent_sessions_current_thread_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `control_agent_sessions_current_thread_idx` ON `control_agent_sessions` (`thread_id`)
WHERE `thread_id` IS NOT NULL AND `status` IN ('created', 'initializing', 'ready', 'busy', 'idle', 'degraded');
