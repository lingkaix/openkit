CREATE TABLE `knowledge_notebook_heads` (
  `workspace_id` text NOT NULL,
  `knowledge_base_id` text PRIMARY KEY NOT NULL,
  `record_json` text NOT NULL,
  CONSTRAINT `knowledge_notebook_heads_json_check` CHECK (json_valid(`record_json`))
);
