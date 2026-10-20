-- Server product metadata has no Workspace or Workspace AgentSession authority.
CREATE TABLE `control_threads` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text CHECK (`workspace_id` IS NULL),
  `status` text NOT NULL CHECK (`status` IN ('active', 'archived')),
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `revision` integer NOT NULL CHECK (`revision` > 0),
  `record_json` text NOT NULL CHECK (json_valid(`record_json`))
);
--> statement-breakpoint
CREATE INDEX `control_threads_workspace_idx` ON `control_threads` (`workspace_id`, `id`);
--> statement-breakpoint
CREATE TABLE `control_turns` (
  `id` text PRIMARY KEY NOT NULL,
  `thread_id` text NOT NULL REFERENCES `control_threads` (`id`),
  `agent_session_id` text CHECK (`agent_session_id` IS NULL),
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
