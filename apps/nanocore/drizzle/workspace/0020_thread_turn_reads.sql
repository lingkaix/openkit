ALTER TABLE `control_turns` ADD `admission_order` integer NOT NULL DEFAULT 0 CHECK (`admission_order` >= 0 AND `admission_order` <= 9007199254740991);
--> statement-breakpoint
-- Preserve the original native insertion order once; later updates never change this key.
UPDATE `control_turns` SET `admission_order` = rowid;
--> statement-breakpoint
-- Every existing publisher shares the same first-insert allocation and covering transaction.
CREATE TRIGGER `control_turns_assign_admission_order` AFTER INSERT ON `control_turns`
WHEN NEW.admission_order = 0
BEGIN
  UPDATE control_turns SET admission_order = (SELECT max(admission_order) + 1 FROM control_turns) WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER `control_turns_keep_admission_order` BEFORE UPDATE OF admission_order ON `control_turns`
WHEN OLD.admission_order > 0 AND NEW.admission_order != OLD.admission_order
BEGIN
  SELECT RAISE(ABORT, 'Turn admission order is immutable');
END;
--> statement-breakpoint
CREATE UNIQUE INDEX `control_turns_admission_order_idx` ON `control_turns` (`admission_order`);
--> statement-breakpoint
CREATE INDEX `control_turns_thread_admission_idx` ON `control_turns` (`thread_id`, `admission_order`);
--> statement-breakpoint
-- Item type is immutable. Count original Items without opening bodies or reading later revisions.
CREATE INDEX `control_items_turn_type_idx` ON `control_product_entries` (`turn_id`, json_extract(`identity_json`, '$.type')) WHERE `kind` = 'item' AND `revision` = 1;
