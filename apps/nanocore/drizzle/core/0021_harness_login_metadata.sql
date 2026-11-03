ALTER TABLE `vault_references` ADD `login_provider` text;
--> statement-breakpoint
ALTER TABLE `vault_references` ADD `login_account_id` text;
--> statement-breakpoint
ALTER TABLE `vault_references` ADD `login_quarantined` integer;
