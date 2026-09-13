CREATE TABLE `app_user` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`full_name` text NOT NULL,
	`email` text NOT NULL,
	`phone` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_user_email_unique` ON `app_user` (`email`);--> statement-breakpoint
CREATE TABLE `person` (
	`id` text PRIMARY KEY NOT NULL,
	`external_ref` text,
	`owner_user_id` text NOT NULL,
	`relationship_to_owner` text DEFAULT 'self' NOT NULL,
	`full_name` text NOT NULL,
	`date_of_birth` text,
	`marital_status` text,
	`smoker` integer,
	`emirate` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_external_ref_unique` ON `person` (`external_ref`);--> statement-breakpoint
CREATE INDEX `person_owner_user_id_idx` ON `person` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `application` (
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
	CONSTRAINT "application_age_range" CHECK("application"."age" between 18 and 100),
	CONSTRAINT "confirmed_needs_timestamp" CHECK("application"."status" <> 'confirmed' or "application"."confirmed_at" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_reference_unique` ON `application` (`reference`);--> statement-breakpoint
CREATE INDEX `application_person_id_idx` ON `application` (`person_id`);--> statement-breakpoint
CREATE INDEX `application_status_idx` ON `application` (`status`);--> statement-breakpoint
CREATE TABLE `application_condition` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`raw_text` text NOT NULL,
	`condition_code` text,
	`stability` text DEFAULT 'unknown' NOT NULL,
	`declared_at_intake` integer DEFAULT true NOT NULL,
	`entered_by_user_id` text,
	FOREIGN KEY (`application_id`) REFERENCES `application`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entered_by_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `application_condition_application_id_idx` ON `application_condition` (`application_id`);--> statement-breakpoint
CREATE TABLE `application_expected_provider` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`provider_name` text NOT NULL,
	`tier` text,
	FOREIGN KEY (`application_id`) REFERENCES `application`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `application_medication` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`raw_text` text NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `application`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `application_need` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`raw_text` text NOT NULL,
	`benefit_class` text,
	`horizon_months` integer,
	FOREIGN KEY (`application_id`) REFERENCES `application`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "application_need_horizon_nonneg" CHECK("application_need"."horizon_months" >= 0)
);
--> statement-breakpoint
CREATE INDEX `application_need_application_id_idx` ON `application_need` (`application_id`);--> statement-breakpoint
CREATE TABLE `application_priority` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`raw_text` text NOT NULL,
	`tag` text DEFAULT 'other' NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `application`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `application_procedure` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`raw_text` text NOT NULL,
	`occurred_on` text,
	FOREIGN KEY (`application_id`) REFERENCES `application`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `application_status_history` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`changed_by` text NOT NULL,
	`changed_by_user_id` text,
	`reason` text,
	`changed_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `application`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`changed_by_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `application_status_history_app_changed_idx` ON `application_status_history` (`application_id`,`changed_at`);--> statement-breakpoint
CREATE TABLE `carrier` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `network_admits` (
	`network` text NOT NULL,
	`provider_tier` text NOT NULL,
	PRIMARY KEY(`network`, `provider_tier`)
);
--> statement-breakpoint
CREATE TABLE `plan` (
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
	CONSTRAINT "maternity_terms_present" CHECK(not "plan"."maternity_covered" or ("plan"."maternity_waiting_period_months" is not null and "plan"."maternity_limit" is not null)),
	CONSTRAINT "chronic_terms_present" CHECK(not "plan"."chronic_covered" or "plan"."chronic_waiting_period_months" is not null)
);
--> statement-breakpoint
CREATE TABLE `assessment` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`cohort` text NOT NULL,
	`confidence` text NOT NULL,
	`created_by` text DEFAULT 'system' NOT NULL,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `application`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assessment_application_id_idx` ON `assessment` (`application_id`);--> statement-breakpoint
CREATE TABLE `assessment_flag` (
	`id` text PRIMARY KEY NOT NULL,
	`assessment_id` text NOT NULL,
	`rule_code` text NOT NULL,
	`severity` text NOT NULL,
	`fields` text DEFAULT '[]' NOT NULL,
	`reason` text NOT NULL,
	FOREIGN KEY (`assessment_id`) REFERENCES `assessment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `assessment_flag_assessment_id_idx` ON `assessment_flag` (`assessment_id`);--> statement-breakpoint
CREATE TABLE `quote` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`annual_premium` numeric NOT NULL,
	`eligible` integer DEFAULT true NOT NULL,
	`rank` integer,
	`score` numeric,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `application`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `plan`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quote_application_id_plan_id_key` ON `quote` (`application_id`,`plan_id`);--> statement-breakpoint
CREATE TABLE `recommendation` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`broker_reasoning` text NOT NULL,
	`member_reasoning` text NOT NULL,
	`created_by` text DEFAULT 'system' NOT NULL,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `application`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `plan`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_live_recommendation` ON `recommendation` (`application_id`) WHERE "recommendation"."status" in ('pending_review', 'approved', 'edited', 'overridden');--> statement-breakpoint
CREATE UNIQUE INDEX `recommendation_application_id_version_key` ON `recommendation` (`application_id`,`version`);--> statement-breakpoint
CREATE TABLE `recommendation_rejection` (
	`id` text PRIMARY KEY NOT NULL,
	`recommendation_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`reason` text NOT NULL,
	FOREIGN KEY (`recommendation_id`) REFERENCES `recommendation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `plan`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recommendation_rejection_recommendation_id_plan_id_key` ON `recommendation_rejection` (`recommendation_id`,`plan_id`);--> statement-breakpoint
CREATE TABLE `review_decision` (
	`id` text PRIMARY KEY NOT NULL,
	`review_task_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`action` text NOT NULL,
	`notes` text,
	`payload` text,
	`decided_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`review_task_id`) REFERENCES `review_task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_decision_review_task_id_idx` ON `review_decision` (`review_task_id`);--> statement-breakpoint
CREATE TABLE `review_task` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`reason` text NOT NULL,
	`priority_score` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`assigned_to_user_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`assigned_to_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_task_status_priority_idx` ON `review_task` (`status`,"priority_score" desc);--> statement-breakpoint
CREATE INDEX `review_task_subject_idx` ON `review_task` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `benefit_ledger` (
	`policy_id` text PRIMARY KEY NOT NULL,
	`deductible_met` numeric DEFAULT 0 NOT NULL,
	`annual_paid` numeric DEFAULT 0 NOT NULL,
	`sublimit_used` text DEFAULT '{"maternity":0,"dental_optical":0}' NOT NULL,
	`last_event_id` text,
	`rebuilt_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`policy_id`) REFERENCES `policy`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_event_id`) REFERENCES `servicing_event`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `policy` (
	`id` text PRIMARY KEY NOT NULL,
	`external_ref` text,
	`application_id` text NOT NULL,
	`person_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`recommendation_id` text,
	`policy_number` text NOT NULL,
	`inception_date` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`annual_premium` numeric NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `application`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_id`) REFERENCES `plan`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recommendation_id`) REFERENCES `recommendation`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_external_ref_unique` ON `policy` (`external_ref`);--> statement-breakpoint
CREATE UNIQUE INDEX `policy_application_id_unique` ON `policy` (`application_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `policy_policy_number_unique` ON `policy` (`policy_number`);--> statement-breakpoint
CREATE INDEX `policy_person_id_idx` ON `policy` (`person_id`);--> statement-breakpoint
CREATE TABLE `servicing_event` (
	`id` text PRIMARY KEY NOT NULL,
	`external_ref` text,
	`policy_id` text NOT NULL,
	`kind` text NOT NULL,
	`policy_month` integer NOT NULL,
	`benefit_class` text,
	`setting` text,
	`provider_tier` text,
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
	CONSTRAINT "amount_matches_kind" CHECK(("servicing_event"."kind" = 'preauth' and "servicing_event"."estimated_amount" is not null)
        or ("servicing_event"."kind" in ('claim', 'reimbursement') and "servicing_event"."billed_amount" is not null)
        or ("servicing_event"."kind" = 'appeal'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `servicing_event_external_ref_unique` ON `servicing_event` (`external_ref`);--> statement-breakpoint
CREATE INDEX `servicing_event_policy_month_idx` ON `servicing_event` (`policy_id`,`policy_month`);--> statement-breakpoint
CREATE INDEX `servicing_event_policy_created_idx` ON `servicing_event` (`policy_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `plan_fit_reassessment` (
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
	CONSTRAINT "change_needs_target" CHECK("plan_fit_reassessment"."verdict" <> 'recommend_change' or "plan_fit_reassessment"."recommended_plan_id" is not null)
);
--> statement-breakpoint
CREATE INDEX `plan_fit_reassessment_policy_id_idx` ON `plan_fit_reassessment` (`policy_id`);--> statement-breakpoint
CREATE TABLE `channel_identity` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`person_id` text,
	`channel` text NOT NULL,
	`address` text NOT NULL,
	`display_name` text,
	`verified_at` integer,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `channel_identity_user_id_idx` ON `channel_identity` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_identity_channel_address_key` ON `channel_identity` (`channel`,`address`);--> statement-breakpoint
CREATE TABLE `message_template` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`channel` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`category` text,
	`body` text NOT NULL,
	`variables` text DEFAULT '[]' NOT NULL,
	`external_id` text,
	`approved_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_template_name_channel_locale_key` ON `message_template` (`name`,`channel`,`locale`);--> statement-breakpoint
CREATE TABLE `conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`purpose` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`channel_identity_id` text,
	`user_id` text,
	`person_id` text,
	`application_id` text,
	`policy_id` text,
	`assigned_advisor_id` text,
	`external_thread_id` text,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_inbound_at` integer,
	`last_outbound_at` integer,
	`window_expires_at` integer,
	`closed_at` integer,
	FOREIGN KEY (`channel_identity_id`) REFERENCES `channel_identity`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`application_id`) REFERENCES `application`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`policy_id`) REFERENCES `policy`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_advisor_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversation_application_id_idx` ON `conversation` (`application_id`);--> statement-breakpoint
CREATE INDEX `conversation_policy_id_idx` ON `conversation` (`policy_id`);--> statement-breakpoint
CREATE INDEX `conversation_status_last_inbound_idx` ON `conversation` (`status`,"last_inbound_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_channel_external_thread_id_key` ON `conversation` (`channel`,`external_thread_id`);--> statement-breakpoint
CREATE TABLE `message` (
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
	CONSTRAINT "template_only_outbound" CHECK("message"."type" <> 'template' or "message"."direction" = 'outbound'),
	CONSTRAINT "has_content" CHECK("message"."body_text" is not null or "message"."payload" is not null or "message"."template_id" is not null or "message"."type" = 'media')
);
--> statement-breakpoint
CREATE INDEX `message_conversation_provider_ts_idx` ON `message` (`conversation_id`,`provider_timestamp`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_conversation_id_seq_key` ON `message` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_provider_external_message_id_key` ON `message` (`provider`,`external_message_id`);--> statement-breakpoint
CREATE TABLE `message_media` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`media_type` text NOT NULL,
	`mime_type` text,
	`storage_uri` text NOT NULL,
	`bytes` integer,
	`sha256` text,
	`caption` text,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `conversation_question` (
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
	CONSTRAINT "conversation_question_ask_count_max" CHECK("conversation_question"."ask_count" <= 2),
	CONSTRAINT "answered_has_answer" CHECK("conversation_question"."status" <> 'answered' or "conversation_question"."answered_message_id" is not null)
);
--> statement-breakpoint
CREATE INDEX `conversation_question_conversation_status_idx` ON `conversation_question` (`conversation_id`,`status`);--> statement-breakpoint
CREATE INDEX `conversation_question_field_key_idx` ON `conversation_question` (`field_key`);--> statement-breakpoint
CREATE TABLE `ai_decision` (
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
	CONSTRAINT "ai_decision_confidence_range" CHECK("ai_decision"."confidence" between 0 and 1),
	CONSTRAINT "low_confidence_needs_review" CHECK("ai_decision"."confidence" is null or "ai_decision"."confidence" >= 0.75 or "ai_decision"."requires_review" = true),
	CONSTRAINT "review_resolution_recorded" CHECK("ai_decision"."status" not in ('accepted', 'edited', 'rejected') or "ai_decision"."resolved_at" is not null)
);
--> statement-breakpoint
CREATE INDEX `ai_decision_subject_idx` ON `ai_decision` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `ai_decision_status_requires_review_idx` ON `ai_decision` (`status`,`requires_review`);--> statement-breakpoint
CREATE INDEX `ai_decision_type_created_idx` ON `ai_decision` (`decision_type`,`created_at`);--> statement-breakpoint
CREATE TABLE `model_run` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`prompt_version` text NOT NULL,
	`request` text,
	`response` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_usd` numeric,
	`latency_ms` integer,
	`status` text DEFAULT 'ok' NOT NULL,
	`error_text` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_run_created_at_idx` ON `model_run` (`created_at`);--> statement-breakpoint
CREATE TABLE `conversation_action` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`triggered_by_message_id` text,
	`ai_decision_id` text,
	`action_type` text NOT NULL,
	`tool_name` text,
	`arguments` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`subject_type` text,
	`subject_id` text,
	`result` text,
	`error_text` text,
	`actor_kind` text NOT NULL,
	`actor_user_id` text,
	`idempotency_key` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`triggered_by_message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ai_decision_id`) REFERENCES `ai_decision`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_action_idempotency_key_unique` ON `conversation_action` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `conversation_action_conversation_created_idx` ON `conversation_action` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `conversation_action_subject_idx` ON `conversation_action` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `extraction` (
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
	CONSTRAINT "extraction_confidence_range" CHECK("extraction"."confidence" between 0 and 1),
	CONSTRAINT "no_inference_on_gated_fields" CHECK("extraction"."method" <> 'inferred' or "extraction"."field_key" not in ('application.age', 'application.smoker', 'application.budget', 'application.policy_inception', 'application.marital_status', 'condition.raw_text', 'condition.stability', 'need.benefit_class', 'need.horizon_months'))
);
--> statement-breakpoint
CREATE INDEX `extraction_target_table_row_idx` ON `extraction` (`target_table`,`target_row_id`);--> statement-breakpoint
CREATE INDEX `extraction_conversation_id_idx` ON `extraction` (`conversation_id`);--> statement-breakpoint
CREATE VIEW `customer_event_view` AS 
  select e.id, e.external_ref, e.policy_id, e.kind, e.policy_month, e.benefit_class,
         e.description, e.billed_amount, e.estimated_amount,
         e.outcome, e.plan_pays, e.member_pays,
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
         pl.annual_premium,
         pe.full_name,
         l.deductible_met,
         l.annual_paid,
         l.sublimit_used
  from policy p
  join plan   pl on pl.id = p.plan_id
  join person pe on pe.id = p.person_id
  left join benefit_ledger l on l.policy_id = p.id
;--> statement-breakpoint
CREATE VIEW `ai_review_queue` AS 
  select d.id            as ai_decision_id,
         d.decision_type,
         d.subject_type, d.subject_id,
         d.summary, d.confidence, d.uncertainty_reason,
         d.created_at,
         r.id            as review_task_id,
         r.priority_score,
         r.status        as review_status,
         m.model_id, m.prompt_version
  from ai_decision d
  left join review_task r on r.id = d.review_task_id
  left join model_run  m on m.id = d.model_run_id
  where d.status = 'proposed' and d.requires_review
;--> statement-breakpoint
CREATE VIEW `application_field_provenance` AS 
  select e.target_table, e.target_column, e.target_row_id,
         e.field_key, e.value_text, e.raw_span, e.method, e.confidence,
         c.channel, c.id as conversation_id, msg.provider_timestamp as said_at
  from extraction e
  join conversation c on c.id = e.conversation_id
  left join message msg on msg.id = e.message_id
;