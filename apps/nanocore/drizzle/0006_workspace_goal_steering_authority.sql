CREATE TABLE `pending_user_turn_records` (
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`pending_turn_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`active_turn_id` text NOT NULL,
	`request_id` text NOT NULL,
	`content_item_id` text NOT NULL,
	`input_kind` text NOT NULL,
	`material_id` text,
	`revision_id` text,
	`content_digest` text,
	`queue_mode` text NOT NULL,
	`received_at` text NOT NULL,
	`terminal_claim_kind` text,
	`terminal_claim_id` text,
	`terminal_claimed_at` text,
	PRIMARY KEY(`workspace_id`,`thread_id`),
	CONSTRAINT `pending_user_turn_records_input_kind_check` CHECK (`input_kind` IN ('message', 'material')),
	CONSTRAINT `pending_user_turn_records_input_tuple_check` CHECK ((`input_kind` = 'message' AND `material_id` IS NULL AND `revision_id` IS NULL AND `content_digest` IS NULL) OR (`input_kind` = 'material' AND `material_id` IS NOT NULL AND `revision_id` IS NOT NULL AND `content_digest` IS NOT NULL)),
	CONSTRAINT `pending_user_turn_records_digest_check` CHECK (`content_digest` IS NULL OR (length(`content_digest`) = 71 AND substr(`content_digest`, 1, 7) = 'sha256:' AND substr(`content_digest`, 8) NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT `pending_user_turn_records_queue_mode_check` CHECK (`queue_mode` = 'safe_point_steering'),
	CONSTRAINT `pending_user_turn_records_claim_check` CHECK ((`terminal_claim_kind` IS NULL AND `terminal_claim_id` IS NULL AND `terminal_claimed_at` IS NULL) OR (`terminal_claim_kind` IS NOT NULL AND `terminal_claim_kind` IN ('applied', 'follow-up', 'cancelled') AND `terminal_claim_id` IS NOT NULL AND `terminal_claimed_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_user_turn_records_identity_idx` ON `pending_user_turn_records` (`workspace_id`,`pending_turn_id`);
--> statement-breakpoint
CREATE TABLE `steering_terminal_outcomes` (
	`workspace_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`pending_turn_id` text NOT NULL,
	`outcome_id` text NOT NULL,
	`state` text NOT NULL,
	`send_request_id` text NOT NULL,
	`terminal_request_id` text NOT NULL,
	`content_item_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`active_turn_id` text NOT NULL,
	`input_kind` text NOT NULL,
	`material_id` text,
	`revision_id` text,
	`content_digest` text,
	`follow_up_turn_id` text,
	`follow_up_item_id` text,
	`accepted_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`thread_id`,`pending_turn_id`),
	CONSTRAINT `steering_terminal_outcomes_state_check` CHECK (`state` IN ('follow-up', 'cancelled')),
	CONSTRAINT `steering_terminal_outcomes_input_kind_check` CHECK (`input_kind` IN ('message', 'material')),
	CONSTRAINT `steering_terminal_outcomes_input_tuple_check` CHECK ((`input_kind` = 'message' AND `material_id` IS NULL AND `revision_id` IS NULL AND `content_digest` IS NULL) OR (`input_kind` = 'material' AND `material_id` IS NOT NULL AND `revision_id` IS NOT NULL AND `content_digest` IS NOT NULL)),
	CONSTRAINT `steering_terminal_outcomes_digest_check` CHECK (`content_digest` IS NULL OR (length(`content_digest`) = 71 AND substr(`content_digest`, 1, 7) = 'sha256:' AND substr(`content_digest`, 8) NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT `steering_terminal_outcomes_follow_up_check` CHECK ((`state` = 'follow-up' AND `follow_up_turn_id` IS NOT NULL AND `follow_up_item_id` IS NOT NULL) OR (`state` = 'cancelled' AND `follow_up_turn_id` IS NULL AND `follow_up_item_id` IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `steering_terminal_outcomes_identity_idx` ON `steering_terminal_outcomes` (`workspace_id`,`outcome_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `steering_terminal_outcomes_terminal_request_idx` ON `steering_terminal_outcomes` (`workspace_id`,`thread_id`,`terminal_request_id`);
