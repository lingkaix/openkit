-- Derived read facts only. The migration owner verifies and backfills original bodies before this ledger row.
CREATE INDEX `control_items_turn_failure_idx` ON `control_product_entries`
  (`turn_id`, json_extract(identity_json,'$.type'))
  WHERE kind='item' AND is_current=1 AND json_extract(read_metadata_json,'$.failed')=1;
