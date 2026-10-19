CREATE TABLE `evaluation_candidate_sets` (
  `workspace_id` text NOT NULL,
  `candidate_set_id` text NOT NULL,
  `payload_json` text NOT NULL,
  PRIMARY KEY (`workspace_id`, `candidate_set_id`),
  CONSTRAINT `evaluation_candidate_sets_identity_check` CHECK (length(`candidate_set_id`) > 0),
  CONSTRAINT `evaluation_candidate_sets_payload_check` CHECK (json_valid(`payload_json`))
);
