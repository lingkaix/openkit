CREATE TABLE `thread_read_receipts` (
  `workspace_id` text NOT NULL,
  `thread_id` text NOT NULL,
  `item_ids_json` text NOT NULL,
  PRIMARY KEY (`workspace_id`, `thread_id`)
);
