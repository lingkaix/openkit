-- Provisional ordinal: re-sequence after the S landing, without rewriting prior migrations.
CREATE TABLE `workspace_recovery_admissions` (
  `schema_version` integer NOT NULL DEFAULT 1 CHECK (`schema_version` = 1),
  `admission_id` text PRIMARY KEY NOT NULL,
  `backup_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `purpose` text NOT NULL CHECK (`purpose` IN ('backup', 'move')),
  `state` text NOT NULL CHECK (`state` IN ('prepared', 'finished', 'abandoned')),
  `revision` integer NOT NULL DEFAULT 1 CHECK (`revision` > 0),
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `candidate_ref` text NOT NULL,
  `proof_json` text NOT NULL CHECK (json_valid(`proof_json`))
);
