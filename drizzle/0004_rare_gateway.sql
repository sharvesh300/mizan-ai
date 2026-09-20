CREATE TABLE `application_preference_signal` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`dimension` text NOT NULL,
	`direction` text NOT NULL,
	`strength` real NOT NULL,
	`confidence` real NOT NULL,
	`source` text NOT NULL,
	`reason` text NOT NULL,
	`evidence_table` text,
	`evidence_id` text,
	`round` integer DEFAULT 1 NOT NULL,
	`superseded_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `application`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "preference_signal_strength_range" CHECK("strength" between 0 and 1),
	CONSTRAINT "preference_signal_confidence_range" CHECK("confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE INDEX `preference_signal_application_live_idx` ON `application_preference_signal` (`application_id`,`superseded_at`);