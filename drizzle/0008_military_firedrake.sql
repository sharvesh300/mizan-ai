CREATE TABLE `identity_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text DEFAULT 'uae_pass' NOT NULL,
	`subject` text NOT NULL,
	`assurance_level` text NOT NULL,
	`emirates_id_masked` text NOT NULL,
	`full_name_en` text NOT NULL,
	`date_of_birth` text,
	`mobile` text,
	`email` text,
	`verified_at` integer DEFAULT (unixepoch()) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `identity_verification_user_id_idx` ON `identity_verification` (`user_id`);