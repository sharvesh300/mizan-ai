CREATE TABLE `claim_settlement` (
	`id` text PRIMARY KEY NOT NULL,
	`servicing_event_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`status` text DEFAULT 'awaiting_approval' NOT NULL,
	`amount` numeric NOT NULL,
	`approved_by_user_id` text,
	`approved_at` integer,
	`paid_by_user_id` text,
	`paid_at` integer,
	`payment_reference` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`servicing_event_id`) REFERENCES `servicing_event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`policy_id`) REFERENCES `policy`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paid_by_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "claim_settlement_amount_positive" CHECK("amount" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_settlement_servicing_event_id_unique` ON `claim_settlement` (`servicing_event_id`);--> statement-breakpoint
CREATE INDEX `claim_settlement_policy_id_idx` ON `claim_settlement` (`policy_id`);--> statement-breakpoint
CREATE INDEX `claim_settlement_status_idx` ON `claim_settlement` (`status`);