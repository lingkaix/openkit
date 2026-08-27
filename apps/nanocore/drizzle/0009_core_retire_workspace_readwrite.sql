CREATE TEMP TABLE `core_0009_lineage_guard` (
  `ok` integer NOT NULL CHECK (`ok` = 1)
);
--> statement-breakpoint
INSERT INTO `core_0009_lineage_guard` (`ok`)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM `openkit_access_tokens` AS `candidate`
  INNER JOIN `openkit_access_tokens` AS `survivor`
    ON `survivor`.`predecessor_token_id` = `candidate`.`token_id`
  WHERE `candidate`.`scope` = 'workspace-readwrite'
    AND `candidate`.`status` = 'revoked'
    AND NOT (
      `survivor`.`scope` = 'workspace-readwrite'
      AND `survivor`.`status` = 'revoked'
    )
);
--> statement-breakpoint
DROP TABLE `core_0009_lineage_guard`;
--> statement-breakpoint
INSERT INTO `audit_events` (
  `audit_event_id`,
  `workspace_id`,
  `protocol_version`,
  `thread_id`,
  `turn_id`,
  `item_id`,
  `capability_call_id`,
  `permission_decision_id`,
  `vault_grant_id`,
  `request_id`,
  `actor_json`,
  `subject_json`,
  `agent_id`,
  `agent_session_id`,
  `category`,
  `action`,
  `resource`,
  `resource_revision`,
  `outcome`,
  `severity`,
  `summary`,
  `error_code`,
  `created_at`,
  `occurred_at`
)
SELECT
  'aud_' || `token_id`,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '{"kind":"system","id":"system_core_migration","responsibleUserId":null}',
  NULL,
  NULL,
  NULL,
  'system',
  'auth.token.retire',
  'auth-token:' || `token_id`,
  NULL,
  'succeeded',
  'info',
  'Retired revoked access token.',
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `openkit_access_tokens`
WHERE `scope` = 'workspace-readwrite'
  AND `status` = 'revoked';
--> statement-breakpoint
DELETE FROM `openkit_access_tokens`
WHERE `scope` = 'workspace-readwrite'
  AND `status` = 'revoked';
--> statement-breakpoint
CREATE TEMP TABLE `core_0009_remaining_scope_guard` (
  `ok` integer NOT NULL CHECK (`ok` = 1)
);
--> statement-breakpoint
INSERT INTO `core_0009_remaining_scope_guard` (`ok`)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM `openkit_access_tokens`
  WHERE `scope` NOT IN ('server-admin', 'workspace', 'workspace-readonly')
);
--> statement-breakpoint
DROP TABLE `core_0009_remaining_scope_guard`;
