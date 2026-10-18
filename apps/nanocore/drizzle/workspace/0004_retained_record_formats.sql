-- Version independently decoded JSON payloads; scalar-only rows keep the native journal.
ALTER TABLE `artifact_reviews` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `audit_events` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `backend_workspace_handles` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `capability_calls` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `evidence_bundles` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `generative_presentations` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `goal_card_tasks` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `goal_cards` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `goal_plan_versions` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `goals` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `idempotency_requests` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `mcp_tool_schema_snapshots` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `pending_requests` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `permission_decisions` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `resolved_agent_setups` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `runtime_evidence` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `staged_workspace_reviews` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `task_turn_terminal_facts` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `usage_records` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `worker_output_manifests` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `workspace_apply_plans` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `workspace_apply_results` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `workspace_change_sets` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `workspace_filesystem_staging_roots` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `workspace_input_snapshots` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `workspace_materialization_records` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `workspace_quarantine_records` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `workspace_reconciliation_records` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `workspace_snapshot_collections` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE `workspace_snapshot_cursors` ADD `schema_version` integer DEFAULT 1 NOT NULL;
