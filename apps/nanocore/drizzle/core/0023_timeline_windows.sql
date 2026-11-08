DROP INDEX `control_items_turn_type_idx`;
--> statement-breakpoint
CREATE INDEX `control_items_turn_type_idx` ON `control_product_entries` (`turn_id`, json_extract(identity_json, '$.type'), `sequence`) WHERE kind='item' AND revision=1;
--> statement-breakpoint
CREATE INDEX `audit_events_turn_action_idx` ON `audit_events` (`turn_id`, `action`, `created_at`, `audit_event_id`);
--> statement-breakpoint
CREATE INDEX `control_items_thread_actor_idx` ON `control_product_entries` (json_extract(identity_json, '$.threadId'), json_extract(identity_json, '$.actor.id')) WHERE kind='item' AND revision=1;
