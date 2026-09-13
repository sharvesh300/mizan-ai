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
;