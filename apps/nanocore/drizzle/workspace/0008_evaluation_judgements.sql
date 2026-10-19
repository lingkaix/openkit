ALTER TABLE `artifact_reviews` ADD COLUMN `judgements` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `workspace_material_revisions` ADD COLUMN `judgements` text NOT NULL DEFAULT '[]';
