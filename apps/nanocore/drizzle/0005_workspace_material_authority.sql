CREATE TABLE `workspace_materials` (
	`workspace_id` text NOT NULL,
	`material_id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`current_revision_id` text,
	`sensitivity` text NOT NULL,
	`last_mutation_request_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`material_id`),
	CONSTRAINT `workspace_materials_kind_check` CHECK (`kind` IN ('markdown', 'text')),
	CONSTRAINT `workspace_materials_sensitivity_check` CHECK (`sensitivity` IN ('public', 'internal', 'restricted'))
);
--> statement-breakpoint
CREATE INDEX `workspace_materials_list_idx` ON `workspace_materials` (`workspace_id`,`created_at`,`material_id`);
--> statement-breakpoint
CREATE TABLE `workspace_material_revisions` (
	`workspace_id` text NOT NULL,
	`material_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`parent_revision_id` text,
	`media_type` text NOT NULL,
	`content_digest` text NOT NULL,
	`content` text NOT NULL,
	`author_id` text NOT NULL,
	`created_by_request_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`material_id`,`revision_id`),
	CONSTRAINT `workspace_material_revisions_media_type_check` CHECK (`media_type` IN ('text/markdown', 'text/plain')),
	CONSTRAINT `workspace_material_revisions_digest_check` CHECK (length(`content_digest`) = 71 AND substr(`content_digest`, 1, 7) = 'sha256:' AND substr(`content_digest`, 8) NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE INDEX `workspace_material_revisions_list_idx` ON `workspace_material_revisions` (`workspace_id`,`material_id`,`created_at`,`revision_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_material_revisions_root_idx` ON `workspace_material_revisions` (`workspace_id`,`material_id`) WHERE `parent_revision_id` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_material_revisions_child_idx` ON `workspace_material_revisions` (`workspace_id`,`material_id`,`parent_revision_id`) WHERE `parent_revision_id` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `thread_material_bindings` (
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`material_id` text NOT NULL,
	`binding_state` text NOT NULL,
	`latest_queued_revision_id` text,
	`inclusion_state` text NOT NULL,
	`last_mutation_request_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`thread_id`,`material_id`),
	CONSTRAINT `thread_material_bindings_state_check` CHECK (`binding_state` IN ('bound', 'unbound')),
	CONSTRAINT `thread_material_bindings_inclusion_check` CHECK (`inclusion_state` IN ('included', 'excluded')),
	CONSTRAINT `thread_material_bindings_unbound_check` CHECK (`binding_state` = 'bound' OR (`latest_queued_revision_id` IS NULL AND `inclusion_state` = 'included')),
	CONSTRAINT `thread_material_bindings_excluded_check` CHECK (`inclusion_state` = 'included' OR (`binding_state` = 'bound' AND `latest_queued_revision_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_material_bindings_bound_thread_idx` ON `thread_material_bindings` (`workspace_id`,`thread_id`) WHERE `binding_state` = 'bound';
--> statement-breakpoint
CREATE INDEX `thread_material_bindings_material_queue_idx` ON `thread_material_bindings` (`workspace_id`,`material_id`,`binding_state`,`thread_id`);
