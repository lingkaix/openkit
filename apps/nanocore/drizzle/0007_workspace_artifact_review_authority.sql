CREATE TABLE `artifact_reviews` (
	`workspace_id` text NOT NULL,
	`review_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`artifact_version` integer NOT NULL,
	`content_digest` text NOT NULL,
	`source_thread_id` text,
	`source_turn_id` text,
	`source_agent_id` text,
	`proposal_material_id` text,
	`proposal_base_revision_id` text,
	`proposal_base_content_digest` text,
	`decision` text,
	`decision_actor_id` text,
	`decision_request_id` text,
	`feedback` text,
	`decided_at` text,
	`follow_up_turn_id` text,
	`applied_material_revision_id` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`,`artifact_id`,`artifact_version`),
	CONSTRAINT `artifact_reviews_review_id_check` CHECK (length(`review_id`) = 29 AND substr(`review_id`, 1, 5) = 'arev_' AND substr(`review_id`, 6) NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT `artifact_reviews_version_check` CHECK (typeof(`artifact_version`) = 'integer' AND `artifact_version` > 0),
	CONSTRAINT `artifact_reviews_content_digest_check` CHECK (length(`content_digest`) = 71 AND substr(`content_digest`, 1, 7) = 'sha256:' AND substr(`content_digest`, 8) NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT `artifact_reviews_proposal_tuple_check` CHECK ((`proposal_material_id` IS NULL AND `proposal_base_revision_id` IS NULL AND `proposal_base_content_digest` IS NULL) OR (`proposal_material_id` IS NOT NULL AND `proposal_base_revision_id` IS NOT NULL AND `proposal_base_content_digest` IS NOT NULL)),
	CONSTRAINT `artifact_reviews_proposal_digest_check` CHECK (`proposal_base_content_digest` IS NULL OR (length(`proposal_base_content_digest`) = 71 AND substr(`proposal_base_content_digest`, 1, 7) = 'sha256:' AND substr(`proposal_base_content_digest`, 8) NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT `artifact_reviews_feedback_check` CHECK (`feedback` IS NULL OR length(`feedback`) > 0),
	CONSTRAINT `artifact_reviews_decision_check` CHECK (
		(
			`decision` IS NULL
			AND `decision_actor_id` IS NULL
			AND `decision_request_id` IS NULL
			AND `feedback` IS NULL
			AND `decided_at` IS NULL
			AND `follow_up_turn_id` IS NULL
			AND `applied_material_revision_id` IS NULL
		) OR (
			`decision` IN ('accepted', 'needs_refinement', 'redo', 'rejected', 'deferred')
			AND `decision_actor_id` IS NOT NULL
			AND `decision_request_id` IS NOT NULL
			AND length(`decision_request_id`) > 0
			AND `decided_at` IS NOT NULL
			AND (
				(`decision` IN ('needs_refinement', 'redo') AND `feedback` IS NOT NULL AND `follow_up_turn_id` IS NOT NULL AND `applied_material_revision_id` IS NULL)
				OR (`decision` = 'accepted' AND `follow_up_turn_id` IS NULL AND ((`proposal_material_id` IS NULL AND `applied_material_revision_id` IS NULL) OR (`proposal_material_id` IS NOT NULL AND `applied_material_revision_id` IS NOT NULL)))
				OR (`decision` IN ('rejected', 'deferred') AND `follow_up_turn_id` IS NULL AND `applied_material_revision_id` IS NULL)
			)
		)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_reviews_identity_idx` ON `artifact_reviews` (`workspace_id`,`review_id`);
