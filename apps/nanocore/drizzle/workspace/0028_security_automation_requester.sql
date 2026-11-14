-- One-way carry-forward: the existing Pending owner gains one closed requester value.
DROP TRIGGER pending_requests_goal_scope_insert;

--> statement-breakpoint

DROP TRIGGER pending_requests_goal_scope_update;

--> statement-breakpoint

DROP TRIGGER goals_attention_scope_insert;

--> statement-breakpoint

DROP TRIGGER goals_attention_scope_delete;

--> statement-breakpoint

DROP TRIGGER goal_card_tasks_attention_scope_insert;

--> statement-breakpoint

DROP TRIGGER goal_card_tasks_attention_scope_delete;

--> statement-breakpoint

CREATE TABLE `pending_requests_automation_next` (
  `request_id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `thread_id` text NOT NULL,
  `raising_turn_id` text NOT NULL,
  `request_item_id` text NOT NULL,
  `kind` text NOT NULL,
  `requester_kind` text NOT NULL,
  `agent_id` text,
  `agent_session_id` text,
  `responsible_user_id` text NOT NULL,
  `state` text NOT NULL,
  `resolution` text,
  `deciding_actor_kind` text,
  `deciding_actor_id` text,
	`deciding_actor_context_json` text,
  `decided_at` text,
  `answer_map_json` text,
  `ending` text,
  `invalidating_event` text,
  `ending_actor_kind` text,
  `ending_actor_id` text,
  `ended_at` text,
  `server_id` text,
  `catalog_revision` text,
  `schema_snapshot_id` text,
  `tool_name` text,
  `canonical_arguments_json` text,
  `arguments_digest` text,
  `package_digest` text,
  `policy_decision_id` text,
  `authorization_context_json` text,
  `governed_intent_json` text,
  `questions_json` text,
  `approval_kind` text,
  `title` text,
  `description` text,
  `claim` text NOT NULL,
  `execution_call_id` text,
  `disposition` text,
  `disposition_reason` text,
  `held_result_json` text,
  `publication_turn_id` text,
  `invalidation_turn_id` text,
  `delivery` text NOT NULL,
  `delivery_turn_id` text,
  `delivery_cause` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  assistant_handoff_json text,
  schema_version integer DEFAULT 1 NOT NULL,
  read_goal_id text,
  CONSTRAINT `pending_requests_kind_check` CHECK (`kind` IN ('approval', 'user-input')),
  CONSTRAINT `pending_requests_requester_kind_check` CHECK (`requester_kind` IN ('worker', 'assistant', 'coordinator', 'person', 'automation')),
  CONSTRAINT `pending_requests_state_check` CHECK (`state` IN ('pending', 'resolved', 'ended')),
  CONSTRAINT `pending_requests_resolution_check` CHECK (`resolution` IS NULL OR `resolution` IN ('granted', 'denied', 'answered')),
  CONSTRAINT `pending_requests_deciding_actor_kind_check` CHECK (`deciding_actor_kind` IS NULL OR `deciding_actor_kind` IN ('user', 'system')),
  CONSTRAINT `pending_requests_ending_check` CHECK (`ending` IS NULL OR `ending` IN ('withdrawn', 'invalidated')),
  CONSTRAINT `pending_requests_ending_actor_kind_check` CHECK (`ending_actor_kind` IS NULL OR `ending_actor_kind` IN ('user', 'system')),
  CONSTRAINT `pending_requests_claim_check` CHECK (`claim` IN ('unclaimed', 'claimed', 'finished')),
  CONSTRAINT `pending_requests_disposition_check` CHECK (`disposition` IS NULL OR `disposition` IN ('approved-executed', 'denied-not-executed', 'execution-error', 'outcome-unknown')),
  CONSTRAINT `pending_requests_delivery_check` CHECK (`delivery` IN ('undelivered', 'frozen', 'delivered', 'delivery-unknown', 'closed-out')),
  CONSTRAINT `pending_requests_delivery_cause_check` CHECK (`delivery_cause` IS NULL OR `delivery_cause` IN ('outcome', 'carried')),
  CONSTRAINT `pending_requests_approval_kind_check` CHECK (`approval_kind` IS NULL OR `approval_kind` IN ('permission', 'destructive-action'))
);

--> statement-breakpoint

INSERT INTO pending_requests_automation_next SELECT * FROM pending_requests;

--> statement-breakpoint

DROP TABLE pending_requests;

--> statement-breakpoint

ALTER TABLE pending_requests_automation_next RENAME TO pending_requests;

--> statement-breakpoint

CREATE INDEX `pending_requests_thread_state_idx` ON `pending_requests` (`workspace_id`, `thread_id`, `state`);

--> statement-breakpoint

CREATE INDEX `pending_requests_thread_active_idx` ON `pending_requests` (`workspace_id`,`thread_id`,`created_at`,`request_id`) WHERE state='pending';

--> statement-breakpoint

CREATE INDEX pending_requests_goal_active_idx ON pending_requests(workspace_id,read_goal_id,created_at,request_id) WHERE state='pending';

--> statement-breakpoint

CREATE TRIGGER pending_requests_goal_scope_insert AFTER INSERT ON pending_requests BEGIN
UPDATE pending_requests SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=NEW.thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=NEW.thread_id LIMIT 1) WHERE request_id=NEW.request_id;
END;

--> statement-breakpoint

CREATE TRIGGER pending_requests_goal_scope_update AFTER UPDATE OF thread_id ON pending_requests BEGIN
UPDATE pending_requests SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=NEW.thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=NEW.thread_id LIMIT 1) WHERE request_id=NEW.request_id;
END;

--> statement-breakpoint

CREATE TRIGGER goals_attention_scope_insert AFTER INSERT ON goals BEGIN
UPDATE pending_requests SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=pending_requests.thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=pending_requests.thread_id LIMIT 1) WHERE thread_id=NEW.thread_id;
UPDATE artifact_reviews SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=artifact_reviews.source_thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=artifact_reviews.source_thread_id LIMIT 1) WHERE source_thread_id=NEW.thread_id;
END;

--> statement-breakpoint

CREATE TRIGGER goals_attention_scope_delete AFTER DELETE ON goals BEGIN
UPDATE pending_requests SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=pending_requests.thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=pending_requests.thread_id LIMIT 1) WHERE thread_id=OLD.thread_id;
UPDATE artifact_reviews SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=artifact_reviews.source_thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=artifact_reviews.source_thread_id LIMIT 1) WHERE source_thread_id=OLD.thread_id;
END;

--> statement-breakpoint

CREATE TRIGGER goal_card_tasks_attention_scope_insert AFTER INSERT ON goal_card_tasks BEGIN
UPDATE pending_requests SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=pending_requests.thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=pending_requests.thread_id LIMIT 1) WHERE thread_id=NEW.thread_id;
UPDATE artifact_reviews SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=artifact_reviews.source_thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=artifact_reviews.source_thread_id LIMIT 1) WHERE source_thread_id=NEW.thread_id;
END;

--> statement-breakpoint

CREATE TRIGGER goal_card_tasks_attention_scope_delete AFTER DELETE ON goal_card_tasks BEGIN
UPDATE pending_requests SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=pending_requests.thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=pending_requests.thread_id LIMIT 1) WHERE thread_id=OLD.thread_id;
UPDATE artifact_reviews SET read_goal_id=(SELECT goal_id FROM goals WHERE thread_id=artifact_reviews.source_thread_id UNION ALL SELECT goal_id FROM goal_card_tasks WHERE thread_id=artifact_reviews.source_thread_id LIMIT 1) WHERE source_thread_id=OLD.thread_id;
END;
