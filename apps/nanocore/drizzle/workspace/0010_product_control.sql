CREATE TABLE `control_workspaces` (
  `id` text PRIMARY KEY NOT NULL,
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `revision` integer NOT NULL CHECK (`revision` > 0),
  `record_json` text NOT NULL CHECK (json_valid(`record_json`))
);
--> statement-breakpoint
CREATE TABLE `control_threads` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `control_workspaces` (`id`),
  `status` text NOT NULL CHECK (`status` IN ('active', 'archived')),
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `revision` integer NOT NULL CHECK (`revision` > 0),
  `record_json` text NOT NULL CHECK (json_valid(`record_json`))
);
--> statement-breakpoint
CREATE INDEX `control_threads_workspace_idx` ON `control_threads` (`workspace_id`, `id`);
--> statement-breakpoint
CREATE TABLE `control_agent_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `control_workspaces` (`id`),
  `thread_id` text REFERENCES `control_threads` (`id`),
  `status` text NOT NULL CHECK (`status` IN ('created', 'initializing', 'ready', 'busy', 'idle', 'degraded', 'interrupted', 'failed', 'closed')),
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `revision` integer NOT NULL CHECK (`revision` > 0),
  `record_json` text NOT NULL CHECK (json_valid(`record_json`))
);
--> statement-breakpoint
-- Current selection is independent of active-Turn single flight; terminal predecessors remain historical.
CREATE UNIQUE INDEX `control_agent_sessions_current_thread_idx` ON `control_agent_sessions` (`thread_id`) WHERE `thread_id` IS NOT NULL AND `status` NOT IN ('closed', 'failed');
--> statement-breakpoint
CREATE TABLE `control_turns` (
  `id` text PRIMARY KEY NOT NULL,
  `thread_id` text NOT NULL REFERENCES `control_threads` (`id`),
  `agent_session_id` text REFERENCES `control_agent_sessions` (`id`),
  `status` text NOT NULL CHECK (`status` IN ('pending', 'running', 'completed', 'interrupted', 'cancelled', 'failed')),
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `revision` integer NOT NULL CHECK (`revision` > 0),
  `record_json` text NOT NULL CHECK (json_valid(`record_json`))
);
--> statement-breakpoint
CREATE INDEX `control_turns_thread_idx` ON `control_turns` (`thread_id`, `id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_turns_active_thread_idx` ON `control_turns` (`thread_id`) WHERE `status` IN ('pending', 'running');
--> statement-breakpoint
CREATE UNIQUE INDEX `control_turns_active_session_idx` ON `control_turns` (`agent_session_id`) WHERE `status` IN ('pending', 'running') AND `agent_session_id` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `control_product_entries` (
  `kind` text NOT NULL CHECK (`kind` IN ('item', 'event')),
  `turn_id` text NOT NULL REFERENCES `control_turns` (`id`),
  `sequence` integer NOT NULL CHECK (`sequence` > 0),
  `id` text NOT NULL,
  `revision` integer NOT NULL CHECK (`revision` > 0),
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `content_json` text NOT NULL CHECK (json_valid(`content_json`)),
  `identity_json` text NOT NULL CHECK (json_valid(`identity_json`)),
  PRIMARY KEY (`kind`, `turn_id`, `sequence`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_product_entries_revision_idx` ON `control_product_entries` (`kind`, `id`, `revision`);
