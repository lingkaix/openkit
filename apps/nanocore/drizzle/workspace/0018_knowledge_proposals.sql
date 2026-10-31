CREATE TABLE `knowledge_notebook_proposals` (
  `workspace_id` text NOT NULL,
  `knowledge_base_id` text NOT NULL,
  `proposal_id` text PRIMARY KEY NOT NULL,
  `record_json` text NOT NULL,
  `reviews_json` text NOT NULL,
  CONSTRAINT `knowledge_notebook_proposals_record_check` CHECK (json_valid(`record_json`)),
  CONSTRAINT `knowledge_notebook_proposals_reviews_check` CHECK (json_valid(`reviews_json`) AND json_type(`reviews_json`) = 'array')
);
