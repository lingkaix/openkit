ALTER TABLE `control_turns` ADD COLUMN `thread_read_order` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
WITH ranks AS (SELECT id, row_number() OVER (PARTITION BY thread_id ORDER BY admission_order) AS n FROM control_turns)
UPDATE control_turns SET thread_read_order=(SELECT n FROM ranks WHERE ranks.id=control_turns.id);
--> statement-breakpoint
CREATE INDEX `control_turns_thread_read_order_idx` ON `control_turns` (`thread_id`,`thread_read_order`);
--> statement-breakpoint
CREATE TRIGGER control_turns_read_order_insert AFTER INSERT ON control_turns BEGIN
  UPDATE control_turns SET thread_read_order=(SELECT coalesce(max(thread_read_order),0)+1 FROM control_turns WHERE thread_id=NEW.thread_id AND id<>NEW.id) WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER control_turns_read_order_delete AFTER DELETE ON control_turns BEGIN
  UPDATE control_turns SET thread_read_order=thread_read_order-1 WHERE thread_id=OLD.thread_id AND thread_read_order>OLD.thread_read_order;
END;
--> statement-breakpoint
ALTER TABLE `control_product_entries` ADD COLUMN `read_metadata_json` text;
--> statement-breakpoint
ALTER TABLE `control_product_entries` ADD COLUMN `is_current` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `control_product_entries` ADD COLUMN `turn_admission_order` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `control_product_entries` ADD COLUMN `item_order` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE control_product_entries SET
  is_current=CASE WHEN revision=(SELECT max(e.revision) FROM control_product_entries e WHERE e.kind=control_product_entries.kind AND e.id=control_product_entries.id) THEN 1 ELSE 0 END,
  turn_admission_order=(SELECT admission_order FROM control_turns WHERE id=control_product_entries.turn_id),
  item_order=(SELECT sequence FROM control_product_entries e WHERE e.kind=control_product_entries.kind AND e.id=control_product_entries.id AND e.revision=1);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_product_current_idx` ON `control_product_entries` (`kind`,`id`) WHERE is_current=1;
--> statement-breakpoint
CREATE INDEX `control_items_thread_read_idx` ON `control_product_entries` (json_extract(identity_json,'$.threadId'),json_extract(identity_json,'$.type'),turn_admission_order,item_order) WHERE kind='item' AND is_current=1;
--> statement-breakpoint
CREATE INDEX `control_items_turn_status_idx` ON `control_product_entries` (turn_id,json_extract(identity_json,'$.type'),json_extract(read_metadata_json,'$.status'),item_order) WHERE kind='item' AND is_current=1;
--> statement-breakpoint
CREATE INDEX `control_items_request_idx` ON `control_product_entries` (json_extract(read_metadata_json,'$.requestId')) WHERE kind='item' AND is_current=1;
--> statement-breakpoint
CREATE INDEX `control_items_causation_idx` ON `control_product_entries` (json_extract(identity_json,'$.causationId')) WHERE kind='item' AND is_current=1;
--> statement-breakpoint
CREATE TRIGGER control_product_read_index_insert AFTER INSERT ON control_product_entries BEGIN
  UPDATE control_product_entries SET is_current=0 WHERE kind=NEW.kind AND id=NEW.id AND is_current=1;
  UPDATE control_product_entries SET is_current=1,
    turn_admission_order=(SELECT admission_order FROM control_turns WHERE id=NEW.turn_id),
    item_order=(SELECT sequence FROM control_product_entries WHERE kind=NEW.kind AND id=NEW.id AND revision=1)
    WHERE rowid=NEW.rowid;
END;
--> statement-breakpoint
CREATE INDEX `command_receipts_pending_target_idx` ON `idempotency_requests` (coalesce(json_extract(scope_json,'$.approvalRequestId'),json_extract(scope_json,'$.userInputRequestId'),json_extract(scope_json,'$.pendingRequestId')));
