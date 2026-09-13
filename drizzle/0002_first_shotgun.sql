PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP VIEW `application_field_provenance`;--> statement-breakpoint
CREATE TABLE `__new_extraction` (
	`id` text PRIMARY KEY NOT NULL,
	`ai_decision_id` text,
	`conversation_id` text,
	`message_id` text,
	`question_id` text,
	`field_key` text NOT NULL,
	`target_table` text NOT NULL,
	`target_column` text NOT NULL,
	`target_row_id` text,
	`raw_span` text NOT NULL,
	`span_start` integer,
	`span_end` integer,
	`value_text` text,
	`method` text NOT NULL,
	`confidence` numeric,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`ai_decision_id`) REFERENCES `ai_decision`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`question_id`) REFERENCES `conversation_question`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "extraction_confidence_range" CHECK("confidence" between 0 and 1),
	CONSTRAINT "no_inference_on_gated_fields" CHECK("method" <> 'inferred' or "field_key" not in ('person.relationship', 'person.full_name', 'application.age', 'application.smoker', 'application.budget', 'application.policy_inception', 'application.marital_status', 'condition.raw_text', 'condition.stability', 'need.benefit_class', 'need.horizon_months'))
);
--> statement-breakpoint
INSERT INTO `__new_extraction`("id", "ai_decision_id", "conversation_id", "message_id", "question_id", "field_key", "target_table", "target_column", "target_row_id", "raw_span", "span_start", "span_end", "value_text", "method", "confidence", "created_at") SELECT "id", "ai_decision_id", "conversation_id", "message_id", "question_id", "field_key", "target_table", "target_column", "target_row_id", "raw_span", "span_start", "span_end", "value_text", "method", "confidence", "created_at" FROM `extraction`;--> statement-breakpoint
DROP TABLE `extraction`;--> statement-breakpoint
ALTER TABLE `__new_extraction` RENAME TO `extraction`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `extraction_target_table_row_idx` ON `extraction` (`target_table`,`target_row_id`);--> statement-breakpoint
CREATE INDEX `extraction_conversation_id_idx` ON `extraction` (`conversation_id`);
CREATE VIEW `application_field_provenance` AS 
  select e.target_table, e.target_column, e.target_row_id,
         e.field_key, e.value_text, e.raw_span, e.method, e.confidence,
         c.channel, c.id as conversation_id, msg.provider_timestamp as said_at
  from extraction e
  join conversation c on c.id = e.conversation_id
  left join message msg on msg.id = e.message_id
;