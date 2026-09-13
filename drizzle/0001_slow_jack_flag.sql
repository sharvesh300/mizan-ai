PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_application` (
	`id` text PRIMARY KEY NOT NULL,
	`reference` text NOT NULL,
	`person_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`intake_source` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`age` integer NOT NULL,
	`marital_status` text,
	`smoker` integer,
	`emirate` text,
	`budget` text NOT NULL,
	`policy_inception` text NOT NULL,
	`treatment_outside_uae_expected` integer DEFAULT false NOT NULL,
	`submitted_at` integer,
	`confirmed_at` integer,
	`status_changed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "application_age_range" CHECK("age" between 18 and 100),
	CONSTRAINT "confirmed_needs_timestamp" CHECK("status" <> 'confirmed' or "confirmed_at" is not null)
);
--> statement-breakpoint
INSERT INTO `__new_application`("id", "reference", "person_id", "created_by_user_id", "intake_source", "status", "age", "marital_status", "smoker", "emirate", "budget", "policy_inception", "treatment_outside_uae_expected", "submitted_at", "confirmed_at", "status_changed_at", "created_at") SELECT "id", "reference", "person_id", "created_by_user_id", "intake_source", "status", "age", "marital_status", "smoker", "emirate", "budget", "policy_inception", "treatment_outside_uae_expected", "submitted_at", "confirmed_at", "status_changed_at", "created_at" FROM `application`;--> statement-breakpoint
DROP TABLE `application`;--> statement-breakpoint
ALTER TABLE `__new_application` RENAME TO `application`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `application_reference_unique` ON `application` (`reference`);--> statement-breakpoint
CREATE INDEX `application_person_id_idx` ON `application` (`person_id`);--> statement-breakpoint
CREATE INDEX `application_status_idx` ON `application` (`status`);--> statement-breakpoint
CREATE TABLE `__new_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`carrier_id` text,
	`name` text NOT NULL,
	`annual_premium` numeric NOT NULL,
	`deductible` numeric NOT NULL,
	`network` text NOT NULL,
	`network_note` text,
	`outpatient_copay_pct` numeric NOT NULL,
	`annual_limit` numeric NOT NULL,
	`dental_optical` text NOT NULL,
	`maternity_covered` integer NOT NULL,
	`maternity_waiting_period_months` integer,
	`maternity_limit` numeric,
	`chronic_covered` integer NOT NULL,
	`chronic_waiting_period_months` integer,
	`effective_from` text,
	`effective_to` text,
	FOREIGN KEY (`carrier_id`) REFERENCES `carrier`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "maternity_terms_present" CHECK(not "maternity_covered" or ("maternity_waiting_period_months" is not null and "maternity_limit" is not null)),
	CONSTRAINT "chronic_terms_present" CHECK(not "chronic_covered" or "chronic_waiting_period_months" is not null)
);
--> statement-breakpoint
INSERT INTO `__new_plan`("id", "carrier_id", "name", "annual_premium", "deductible", "network", "network_note", "outpatient_copay_pct", "annual_limit", "dental_optical", "maternity_covered", "maternity_waiting_period_months", "maternity_limit", "chronic_covered", "chronic_waiting_period_months", "effective_from", "effective_to") SELECT "id", "carrier_id", "name", "annual_premium", "deductible", "network", "network_note", "outpatient_copay_pct", "annual_limit", "dental_optical", "maternity_covered", "maternity_waiting_period_months", "maternity_limit", "chronic_covered", "chronic_waiting_period_months", "effective_from", "effective_to" FROM `plan`;--> statement-breakpoint
DROP TABLE `plan`;--> statement-breakpoint
ALTER TABLE `__new_plan` RENAME TO `plan`;--> statement-breakpoint
CREATE TABLE `__new_servicing_event` (
	`id` text PRIMARY KEY NOT NULL,
	`external_ref` text,
	`policy_id` text NOT NULL,
	`kind` text NOT NULL,
	`policy_month` integer NOT NULL,
	`benefit_class` text,
	`setting` text,
	`provider_tier` text,
	`geography` text DEFAULT 'uae' NOT NULL,
	`billed_amount` numeric,
	`estimated_amount` numeric,
	`description` text,
	`evidence_text` text,
	`submitted_by_user_id` text,
	`occurred_on` text,
	`outcome` text,
	`reason_code` text,
	`plan_pays` numeric,
	`member_pays` numeric,
	`calculation` text,
	`ledger_before` text,
	`ledger_after` text,
	`member_explanation` text,
	`broker_explanation` text,
	`confidence` numeric,
	`uncertainty_reason` text,
	`decided_by` text,
	`decided_by_user_id` text,
	`supersedes_event_id` text,
	`appeal_of_event_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`policy_id`) REFERENCES `policy`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submitted_by_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supersedes_event_id`) REFERENCES `servicing_event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`appeal_of_event_id`) REFERENCES `servicing_event`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "servicing_event_confidence_range" CHECK("confidence" between 0 and 1),
	CONSTRAINT "amount_matches_kind" CHECK(("kind" = 'preauth' and "estimated_amount" is not null)
        or ("kind" in ('claim', 'reimbursement') and "billed_amount" is not null)
        or ("kind" = 'appeal'))
);
--> statement-breakpoint
INSERT INTO `__new_servicing_event`("id", "external_ref", "policy_id", "kind", "policy_month", "benefit_class", "setting", "provider_tier", "billed_amount", "estimated_amount", "description", "evidence_text", "submitted_by_user_id", "occurred_on", "outcome", "reason_code", "plan_pays", "member_pays", "calculation", "ledger_before", "ledger_after", "member_explanation", "broker_explanation", "decided_by", "decided_by_user_id", "supersedes_event_id", "appeal_of_event_id", "created_at") SELECT "id", "external_ref", "policy_id", "kind", "policy_month", "benefit_class", "setting", "provider_tier", "billed_amount", "estimated_amount", "description", "evidence_text", "submitted_by_user_id", "occurred_on", "outcome", "reason_code", "plan_pays", "member_pays", "calculation", "ledger_before", "ledger_after", "member_explanation", "broker_explanation", "decided_by", "decided_by_user_id", "supersedes_event_id", "appeal_of_event_id", "created_at" FROM `servicing_event`;--> statement-breakpoint
DROP TABLE `servicing_event`;--> statement-breakpoint
ALTER TABLE `__new_servicing_event` RENAME TO `servicing_event`;--> statement-breakpoint
CREATE UNIQUE INDEX `servicing_event_external_ref_unique` ON `servicing_event` (`external_ref`);--> statement-breakpoint
CREATE INDEX `servicing_event_policy_month_idx` ON `servicing_event` (`policy_id`,`policy_month`);--> statement-breakpoint
CREATE INDEX `servicing_event_policy_created_idx` ON `servicing_event` (`policy_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_plan_fit_reassessment` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_id` text NOT NULL,
	`triggered_by_event_id` text,
	`verdict` text NOT NULL,
	`recommended_plan_id` text,
	`broker_reasoning` text NOT NULL,
	`member_reasoning` text NOT NULL,
	`created_by` text DEFAULT 'system' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`policy_id`) REFERENCES `policy`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`triggered_by_event_id`) REFERENCES `servicing_event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recommended_plan_id`) REFERENCES `plan`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "change_needs_target" CHECK("verdict" <> 'recommend_change' or "recommended_plan_id" is not null)
);
--> statement-breakpoint
INSERT INTO `__new_plan_fit_reassessment`("id", "policy_id", "triggered_by_event_id", "verdict", "recommended_plan_id", "broker_reasoning", "member_reasoning", "created_by", "created_at") SELECT "id", "policy_id", "triggered_by_event_id", "verdict", "recommended_plan_id", "broker_reasoning", "member_reasoning", "created_by", "created_at" FROM `plan_fit_reassessment`;--> statement-breakpoint
DROP TABLE `plan_fit_reassessment`;--> statement-breakpoint
ALTER TABLE `__new_plan_fit_reassessment` RENAME TO `plan_fit_reassessment`;--> statement-breakpoint
CREATE INDEX `plan_fit_reassessment_policy_id_idx` ON `plan_fit_reassessment` (`policy_id`);--> statement-breakpoint
CREATE TABLE `__new_message` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`direction` text NOT NULL,
	`role` text NOT NULL,
	`type` text DEFAULT 'text' NOT NULL,
	`body_text` text,
	`payload` text,
	`template_id` text,
	`template_variables` text,
	`provider` text,
	`external_message_id` text,
	`delivery_status` text DEFAULT 'pending' NOT NULL,
	`provider_timestamp` integer,
	`received_at` integer,
	`failed_reason` text,
	`in_reply_to_message_id` text,
	`redacted` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `message_template`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`in_reply_to_message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "template_only_outbound" CHECK("type" <> 'template' or "direction" = 'outbound'),
	CONSTRAINT "has_content" CHECK("body_text" is not null or "payload" is not null or "template_id" is not null or "type" = 'media')
);
--> statement-breakpoint
INSERT INTO `__new_message`("id", "conversation_id", "seq", "direction", "role", "type", "body_text", "payload", "template_id", "template_variables", "provider", "external_message_id", "delivery_status", "provider_timestamp", "received_at", "failed_reason", "in_reply_to_message_id", "redacted", "created_at") SELECT "id", "conversation_id", "seq", "direction", "role", "type", "body_text", "payload", "template_id", "template_variables", "provider", "external_message_id", "delivery_status", "provider_timestamp", "received_at", "failed_reason", "in_reply_to_message_id", "redacted", "created_at" FROM `message`;--> statement-breakpoint
DROP TABLE `message`;--> statement-breakpoint
ALTER TABLE `__new_message` RENAME TO `message`;--> statement-breakpoint
CREATE INDEX `message_conversation_provider_ts_idx` ON `message` (`conversation_id`,`provider_timestamp`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_conversation_id_seq_key` ON `message` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_provider_external_message_id_key` ON `message` (`provider`,`external_message_id`);--> statement-breakpoint
CREATE TABLE `__new_conversation_question` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`asked_message_id` text,
	`answered_message_id` text,
	`field_key` text NOT NULL,
	`target_table` text,
	`target_column` text,
	`target_row_id` text,
	`trigger_rule` text,
	`severity` text NOT NULL,
	`question_text` text NOT NULL,
	`status` text DEFAULT 'asked' NOT NULL,
	`ask_count` integer DEFAULT 1 NOT NULL,
	`answer_raw` text,
	`asked_at` integer DEFAULT (unixepoch()) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asked_message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`answered_message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversation_question_ask_count_max" CHECK("ask_count" <= 2),
	CONSTRAINT "answered_has_answer" CHECK("status" <> 'answered' or "answered_message_id" is not null)
);
--> statement-breakpoint
INSERT INTO `__new_conversation_question`("id", "conversation_id", "asked_message_id", "answered_message_id", "field_key", "target_table", "target_column", "target_row_id", "trigger_rule", "severity", "question_text", "status", "ask_count", "answer_raw", "asked_at", "resolved_at") SELECT "id", "conversation_id", "asked_message_id", "answered_message_id", "field_key", "target_table", "target_column", "target_row_id", "trigger_rule", "severity", "question_text", "status", "ask_count", "answer_raw", "asked_at", "resolved_at" FROM `conversation_question`;--> statement-breakpoint
DROP TABLE `conversation_question`;--> statement-breakpoint
ALTER TABLE `__new_conversation_question` RENAME TO `conversation_question`;--> statement-breakpoint
CREATE INDEX `conversation_question_conversation_status_idx` ON `conversation_question` (`conversation_id`,`status`);--> statement-breakpoint
CREATE INDEX `conversation_question_field_key_idx` ON `conversation_question` (`field_key`);--> statement-breakpoint
CREATE TABLE `__new_ai_decision` (
	`id` text PRIMARY KEY NOT NULL,
	`decision_type` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`conversation_id` text,
	`model_run_id` text,
	`output` text NOT NULL,
	`summary` text,
	`confidence` numeric,
	`uncertainty_reason` text,
	`requires_review` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`review_task_id` text,
	`applied_to_id` text,
	`superseded_by_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_run_id`) REFERENCES `model_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`review_task_id`) REFERENCES `review_task`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by_id`) REFERENCES `ai_decision`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_decision_confidence_range" CHECK("confidence" between 0 and 1),
	CONSTRAINT "low_confidence_needs_review" CHECK("confidence" is null or "confidence" >= 0.75 or "requires_review" = true),
	CONSTRAINT "review_resolution_recorded" CHECK("status" not in ('accepted', 'edited', 'rejected') or "resolved_at" is not null)
);
--> statement-breakpoint
INSERT INTO `__new_ai_decision`("id", "decision_type", "subject_type", "subject_id", "conversation_id", "model_run_id", "output", "summary", "confidence", "uncertainty_reason", "requires_review", "status", "review_task_id", "applied_to_id", "superseded_by_id", "created_at", "resolved_at") SELECT "id", "decision_type", "subject_type", "subject_id", "conversation_id", "model_run_id", "output", "summary", "confidence", "uncertainty_reason", "requires_review", "status", "review_task_id", "applied_to_id", "superseded_by_id", "created_at", "resolved_at" FROM `ai_decision`;--> statement-breakpoint
DROP TABLE `ai_decision`;--> statement-breakpoint
ALTER TABLE `__new_ai_decision` RENAME TO `ai_decision`;--> statement-breakpoint
CREATE INDEX `ai_decision_subject_idx` ON `ai_decision` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `ai_decision_status_requires_review_idx` ON `ai_decision` (`status`,`requires_review`);--> statement-breakpoint
CREATE INDEX `ai_decision_type_created_idx` ON `ai_decision` (`decision_type`,`created_at`);--> statement-breakpoint
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
	CONSTRAINT "no_inference_on_gated_fields" CHECK("method" <> 'inferred' or "field_key" not in ('application.age', 'application.smoker', 'application.budget', 'application.policy_inception', 'application.marital_status', 'condition.raw_text', 'condition.stability', 'need.benefit_class', 'need.horizon_months'))
);
--> statement-breakpoint
INSERT INTO `__new_extraction`("id", "ai_decision_id", "conversation_id", "message_id", "question_id", "field_key", "target_table", "target_column", "target_row_id", "raw_span", "span_start", "span_end", "value_text", "method", "confidence", "created_at") SELECT "id", "ai_decision_id", "conversation_id", "message_id", "question_id", "field_key", "target_table", "target_column", "target_row_id", "raw_span", "span_start", "span_end", "value_text", "method", "confidence", "created_at" FROM `extraction`;--> statement-breakpoint
DROP TABLE `extraction`;--> statement-breakpoint
ALTER TABLE `__new_extraction` RENAME TO `extraction`;--> statement-breakpoint
CREATE INDEX `extraction_target_table_row_idx` ON `extraction` (`target_table`,`target_row_id`);--> statement-breakpoint
CREATE INDEX `extraction_conversation_id_idx` ON `extraction` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `__new_recommendation` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`broker_reasoning` text NOT NULL,
	`member_reasoning` text NOT NULL,
	`confidence` numeric,
	`uncertainty_reason` text,
	`created_by` text DEFAULT 'system' NOT NULL,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `application`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `plan`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recommendation_confidence_range" CHECK("confidence" between 0 and 1)
);
--> statement-breakpoint
INSERT INTO `__new_recommendation`("id", "application_id", "plan_id", "version", "status", "broker_reasoning", "member_reasoning", "created_by", "created_by_user_id", "created_at") SELECT "id", "application_id", "plan_id", "version", "status", "broker_reasoning", "member_reasoning", "created_by", "created_by_user_id", "created_at" FROM `recommendation`;--> statement-breakpoint
DROP TABLE `recommendation`;--> statement-breakpoint
ALTER TABLE `__new_recommendation` RENAME TO `recommendation`;--> statement-breakpoint
CREATE UNIQUE INDEX `one_live_recommendation` ON `recommendation` (`application_id`) WHERE "recommendation"."status" in ('pending_review', 'approved', 'edited', 'overridden');--> statement-breakpoint
CREATE UNIQUE INDEX `recommendation_application_id_version_key` ON `recommendation` (`application_id`,`version`);--> statement-breakpoint
DROP VIEW `customer_event_view`;--> statement-breakpoint
DROP VIEW `customer_policy_view`;--> statement-breakpoint
CREATE VIEW `customer_event_view` AS 
  select e.id, e.external_ref, e.policy_id, e.kind, e.policy_month, e.benefit_class,
         e.description, e.billed_amount, e.estimated_amount,
         e.outcome, e.reason_code, e.plan_pays, e.member_pays,
         e.member_explanation as explanation,
         e.calculation, e.created_at
  from servicing_event e
;--> statement-breakpoint
CREATE VIEW `customer_policy_view` AS 
  select p.id            as policy_id,
         p.policy_number,
         p.inception_date,
         p.status,
         pl.name         as plan_name,
         p.annual_premium,
         pe.full_name,
         pl.deductible,
         pl.outpatient_copay_pct,
         pl.network,
         pl.network_note,
         pl.annual_limit,
         pl.dental_optical,
         pl.maternity_covered,
         pl.maternity_waiting_period_months,
         pl.maternity_limit,
         pl.chronic_covered,
         pl.chronic_waiting_period_months,
         l.deductible_met,
         l.annual_paid,
         l.sublimit_used
  from policy p
  join plan   pl on pl.id = p.plan_id
  join person pe on pe.id = p.person_id
  left join benefit_ledger l on l.policy_id = p.id
;