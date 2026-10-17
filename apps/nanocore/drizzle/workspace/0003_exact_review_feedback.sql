ALTER TABLE `artifact_reviews` ADD `range_feedback` text;
--> statement-breakpoint
ALTER TABLE `artifact_reviews` ADD `candidate_selections` text DEFAULT '[]' NOT NULL;
