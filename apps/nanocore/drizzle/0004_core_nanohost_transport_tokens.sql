CREATE TABLE `nanohost_integration_identities` (
	`identity_id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`decommissioned_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nanohost_integration_identities_deployment_idx` ON `nanohost_integration_identities` (`deployment_id`);
--> statement-breakpoint
CREATE TABLE `nanohost_transport_tokens` (
	`token_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`owner_nanohost_identity_id` text NOT NULL,
	`token_type` text NOT NULL,
	`scope` text NOT NULL,
	`deployment_id` text NOT NULL,
	`status` text NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`predecessor_token_id` text,
	`rotation_overlap_expires_at` text,
	`responsible_server_admin_actor_id` text NOT NULL,
	`last_used_at` text,
	`last_used_channel` text,
	`last_used_source` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nanohost_transport_tokens_hash_idx` ON `nanohost_transport_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `nanohost_transport_tokens_owner_idx` ON `nanohost_transport_tokens` (`owner_nanohost_identity_id`,`deployment_id`,`status`);
