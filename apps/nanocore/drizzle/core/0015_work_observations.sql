-- Observation order and identity belong to the same native Turn transaction.
CREATE TABLE `control_work_observations` (
  `turn_id` text NOT NULL REFERENCES `control_turns` (`id`),
  `sequence` integer NOT NULL CHECK (`sequence` > 0),
  `id` text NOT NULL,
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `record_json` text NOT NULL CHECK (json_valid(`record_json`)),
  PRIMARY KEY (`turn_id`, `sequence`),
  UNIQUE (`turn_id`, `id`)
);
