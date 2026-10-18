-- Historical origin stays unknown; only new authenticated input and admitted responses supply these facts.
ALTER TABLE discord_inbound_receipts ADD COLUMN discord_user_id TEXT;
--> statement-breakpoint
ALTER TABLE discord_inbound_receipts ADD COLUMN core_user_id TEXT;
--> statement-breakpoint
ALTER TABLE discord_inbound_receipts ADD COLUMN binding_revision TEXT;
--> statement-breakpoint
ALTER TABLE discord_inbound_receipts ADD COLUMN operation_id TEXT CHECK (operation_id IN ('approval.respond', 'question.answer'));
--> statement-breakpoint
ALTER TABLE discord_inbound_receipts ADD COLUMN workspace_id TEXT;
--> statement-breakpoint
ALTER TABLE discord_inbound_receipts ADD COLUMN thread_id TEXT;
--> statement-breakpoint
ALTER TABLE discord_inbound_receipts ADD COLUMN pending_request_id TEXT;
--> statement-breakpoint
ALTER TABLE discord_inbound_receipts ADD COLUMN turn_id TEXT;
