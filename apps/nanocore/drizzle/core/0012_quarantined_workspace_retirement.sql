-- Native migration runs inside BEGIN, so foreign_keys=OFF would be ineffective.
-- Preserve the two FK child families and their row order across the parent CHECK rebuild.
-- All copies and guard replacement belong to this same transaction; no retained data is discarded.
CREATE TEMP TABLE `retirement_invitations` AS SELECT rowid AS retained_rowid, * FROM `workspace_invitations`;
--> statement-breakpoint
CREATE TEMP TABLE `retirement_members` AS SELECT rowid AS retained_rowid, * FROM `workspace_members`;
--> statement-breakpoint
DROP TRIGGER `workspace_owner_member_delete_guard`;
--> statement-breakpoint
DROP TRIGGER `workspace_owner_member_update_guard`;
--> statement-breakpoint
DROP TRIGGER `workspace_owner_transfer_guard`;
--> statement-breakpoint
CREATE TABLE `workspace_registry_retirement` (
  `workspace_id` text PRIMARY KEY NOT NULL,
  `owner_user_id` text NOT NULL,
  `status` text NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `workspace_registry_status_check` CHECK (`status` IN ('active', 'deleting', 'deleted', 'retired')),
  CONSTRAINT `workspace_registry_revision_check` CHECK (typeof(`revision`) = 'integer' AND `revision` > 0)
);
--> statement-breakpoint
INSERT INTO `workspace_registry_retirement` SELECT * FROM `workspace_registry`;
--> statement-breakpoint
DROP TABLE `workspace_registry`;
--> statement-breakpoint
ALTER TABLE `workspace_registry_retirement` RENAME TO `workspace_registry`;
--> statement-breakpoint
INSERT INTO `workspace_invitations` (rowid, `invitation_id`, `workspace_id`, `invitee_user_id`, `inviter_user_id`, `status`, `expires_at`, `accepted_at`, `declined_at`, `revoked_at`, `revision`, `created_at`, `updated_at`) SELECT retained_rowid, `invitation_id`, `workspace_id`, `invitee_user_id`, `inviter_user_id`, `status`, `expires_at`, `accepted_at`, `declined_at`, `revoked_at`, `revision`, `created_at`, `updated_at` FROM `retirement_invitations`;
--> statement-breakpoint
INSERT INTO `workspace_members` (rowid, `workspace_id`, `user_id`, `status`, `invitation_id`, `joined_at`, `removed_at`, `revision`, `created_at`, `updated_at`) SELECT retained_rowid, `workspace_id`, `user_id`, `status`, `invitation_id`, `joined_at`, `removed_at`, `revision`, `created_at`, `updated_at` FROM `retirement_members`;
--> statement-breakpoint
DROP TABLE `retirement_invitations`;
--> statement-breakpoint
DROP TABLE `retirement_members`;
--> statement-breakpoint
CREATE INDEX `workspace_registry_owner_user_id_idx` ON `workspace_registry` (`owner_user_id`);
--> statement-breakpoint
CREATE TRIGGER `workspace_owner_member_delete_guard`
BEFORE DELETE ON `workspace_members`
WHEN EXISTS (
  SELECT 1 FROM `workspace_registry`
  WHERE `workspace_id` = OLD.`workspace_id` AND `owner_user_id` = OLD.`user_id`
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_owner_membership_required');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_owner_member_update_guard`
BEFORE UPDATE OF `workspace_id`, `user_id`, `status` ON `workspace_members`
WHEN EXISTS (
  SELECT 1 FROM `workspace_registry`
  WHERE `workspace_id` = OLD.`workspace_id` AND `owner_user_id` = OLD.`user_id`
)
AND (NEW.`workspace_id` <> OLD.`workspace_id` OR NEW.`user_id` <> OLD.`user_id` OR NEW.`status` <> 'active')
BEGIN
  SELECT RAISE(ABORT, 'workspace_owner_membership_required');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_owner_transfer_guard`
BEFORE UPDATE OF `owner_user_id` ON `workspace_registry`
WHEN NOT EXISTS (
  SELECT 1 FROM `workspace_members`
  WHERE `workspace_id` = OLD.`workspace_id` AND `user_id` = NEW.`owner_user_id` AND `status` = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_owner_membership_required');
END;
