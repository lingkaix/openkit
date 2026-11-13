-- Rebuildable navigation seeks; original native metadata, Item bytes and admission order stay unchanged.
CREATE INDEX control_turns_navigation_latest_idx ON control_turns (thread_id,coalesce(json_extract(record_json,'$.startedAt'),''),thread_read_order,id);
--> statement-breakpoint
CREATE INDEX control_turns_navigation_started_idx ON control_turns (thread_id,json_extract(record_json,'$.startedAt'));
--> statement-breakpoint
CREATE INDEX control_turns_navigation_completed_idx ON control_turns (thread_id,json_extract(record_json,'$.completedAt'));
--> statement-breakpoint
CREATE INDEX control_items_navigation_created_idx ON control_product_entries (json_extract(identity_json,'$.threadId'),json_extract(read_metadata_json,'$.createdAt')) WHERE kind='item' AND is_current=1;
--> statement-breakpoint
CREATE INDEX control_items_navigation_completed_idx ON control_product_entries (json_extract(identity_json,'$.threadId'),json_extract(read_metadata_json,'$.completedAt')) WHERE kind='item' AND is_current=1;
