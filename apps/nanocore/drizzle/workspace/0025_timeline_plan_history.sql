-- Historical plan observations seek directly by recorded type and append sequence.
CREATE INDEX `control_items_turn_history_type_idx` ON `control_product_entries`
  (`turn_id`, json_extract(identity_json,'$.type'), `sequence`)
  WHERE kind='item';
