CREATE TEMP TABLE `workspace_sharing_preflight` (
  `ok` integer NOT NULL CHECK (`ok` = 1)
);
--> statement-breakpoint
INSERT INTO `workspace_sharing_preflight` (`ok`)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM `workspace_registry` AS `registry`
  LEFT JOIN `workspace_members` AS `member`
    ON `member`.`workspace_id` = `registry`.`workspace_id`
   AND `member`.`user_id` = `registry`.`owner_user_id`
   AND `member`.`status` = 'active'
  WHERE `member`.`user_id` IS NULL
);
--> statement-breakpoint
DROP TABLE `workspace_sharing_preflight`;
--> statement-breakpoint
ALTER TABLE `workspace_members` RENAME TO `__old_workspace_members`;
--> statement-breakpoint
ALTER TABLE `workspace_registry` RENAME TO `__old_workspace_registry`;
--> statement-breakpoint
DROP INDEX IF EXISTS `workspace_members_user_id_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `workspace_registry_owner_user_id_idx`;
--> statement-breakpoint
CREATE TABLE `workspace_registry` (
  `workspace_id` text PRIMARY KEY NOT NULL,
  `owner_user_id` text NOT NULL,
  `status` text NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `workspace_registry_status_check` CHECK (`status` IN ('active', 'deleting', 'deleted')),
  CONSTRAINT `workspace_registry_revision_check` CHECK (typeof(`revision`) = 'integer' AND `revision` > 0)
);
--> statement-breakpoint
CREATE INDEX `workspace_registry_owner_user_id_idx` ON `workspace_registry` (`owner_user_id`);
--> statement-breakpoint
INSERT INTO `workspace_registry` (
  `workspace_id`, `owner_user_id`, `status`, `revision`, `created_at`, `updated_at`
)
SELECT `workspace_id`, `owner_user_id`, `status`, 1, `created_at`, `updated_at`
FROM `__old_workspace_registry`;
--> statement-breakpoint
CREATE TABLE `workspace_invitations` (
  `invitation_id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `invitee_user_id` text NOT NULL,
  `proposed_access_level` text NOT NULL,
  `inviter_user_id` text NOT NULL,
  `status` text NOT NULL,
  `expires_at` text NOT NULL,
  `accepted_at` text,
  `declined_at` text,
  `revoked_at` text,
  `revision` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspace_registry`(`workspace_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`invitee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`inviter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `workspace_invitations_access_check` CHECK (`proposed_access_level` IN ('editor', 'viewer')),
  CONSTRAINT `workspace_invitations_status_check` CHECK (`status` IN ('pending', 'accepted', 'declined', 'revoked')),
  CONSTRAINT `workspace_invitations_revision_check` CHECK (typeof(`revision`) = 'integer' AND `revision` > 0),
  CONSTRAINT `workspace_invitations_terminal_check` CHECK (
    (`status` = 'pending' AND `accepted_at` IS NULL AND `declined_at` IS NULL AND `revoked_at` IS NULL)
    OR (`status` = 'accepted' AND `accepted_at` IS NOT NULL AND `declined_at` IS NULL AND `revoked_at` IS NULL)
    OR (`status` = 'declined' AND `accepted_at` IS NULL AND `declined_at` IS NOT NULL AND `revoked_at` IS NULL)
    OR (`status` = 'revoked' AND `accepted_at` IS NULL AND `declined_at` IS NULL AND `revoked_at` IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX `workspace_invitations_workspace_idx` ON `workspace_invitations` (`workspace_id`, `status`, `created_at`);
--> statement-breakpoint
CREATE INDEX `workspace_invitations_invitee_idx` ON `workspace_invitations` (`invitee_user_id`, `status`, `expires_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_invitations_pending_idx`
  ON `workspace_invitations` (`workspace_id`, `invitee_user_id`)
  WHERE `status` = 'pending';
--> statement-breakpoint
CREATE TABLE `workspace_members` (
  `workspace_id` text NOT NULL,
  `user_id` text NOT NULL,
  `status` text NOT NULL,
  `access_level` text NOT NULL,
  `invitation_id` text,
  `joined_at` text NOT NULL,
  `removed_at` text,
  `revision` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`workspace_id`, `user_id`),
  FOREIGN KEY (`workspace_id`) REFERENCES `workspace_registry`(`workspace_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`invitation_id`) REFERENCES `workspace_invitations`(`invitation_id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `workspace_members_status_check` CHECK (`status` IN ('active', 'removed')),
  CONSTRAINT `workspace_members_access_check` CHECK (`access_level` IN ('editor', 'viewer')),
  CONSTRAINT `workspace_members_revision_check` CHECK (typeof(`revision`) = 'integer' AND `revision` > 0),
  CONSTRAINT `workspace_members_lifecycle_check` CHECK (
    (`status` = 'active' AND `removed_at` IS NULL)
    OR (`status` = 'removed' AND `removed_at` IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX `workspace_members_user_id_idx` ON `workspace_members` (`user_id`, `status`, `workspace_id`);
--> statement-breakpoint
INSERT INTO `workspace_members` (
  `workspace_id`, `user_id`, `status`, `access_level`, `invitation_id`,
  `joined_at`, `removed_at`, `revision`, `created_at`, `updated_at`
)
SELECT
  `workspace_id`,
  `user_id`,
  `status`,
  'editor',
  NULL,
  `created_at`,
  CASE WHEN `status` = 'removed' THEN `updated_at` ELSE NULL END,
  1,
  `created_at`,
  `updated_at`
FROM `__old_workspace_members`;
--> statement-breakpoint
DROP TABLE `__old_workspace_members`;
--> statement-breakpoint
DROP TABLE `__old_workspace_registry`;
--> statement-breakpoint
CREATE TRIGGER `workspace_owner_member_update_guard`
BEFORE UPDATE OF `workspace_id`, `user_id`, `status`, `access_level` ON `workspace_members`
WHEN EXISTS (
  SELECT 1
  FROM `workspace_registry`
  WHERE `workspace_id` = OLD.`workspace_id`
    AND `owner_user_id` = OLD.`user_id`
)
AND (
  NEW.`workspace_id` <> OLD.`workspace_id`
  OR NEW.`user_id` <> OLD.`user_id`
  OR NEW.`status` <> 'active'
  OR NEW.`access_level` <> 'editor'
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_owner_membership_required');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_owner_member_delete_guard`
BEFORE DELETE ON `workspace_members`
WHEN EXISTS (
  SELECT 1
  FROM `workspace_registry`
  WHERE `workspace_id` = OLD.`workspace_id`
    AND `owner_user_id` = OLD.`user_id`
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_owner_membership_required');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_owner_transfer_guard`
BEFORE UPDATE OF `owner_user_id` ON `workspace_registry`
WHEN NOT EXISTS (
  SELECT 1
  FROM `workspace_members`
  WHERE `workspace_id` = OLD.`workspace_id`
    AND `user_id` = NEW.`owner_user_id`
    AND `status` = 'active'
    AND `access_level` = 'editor'
)
BEGIN
  SELECT RAISE(ABORT, 'workspace_owner_membership_required');
END;
