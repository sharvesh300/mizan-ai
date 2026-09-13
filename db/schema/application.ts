// =====================================================================
// 2 · APPLICATION — the immutable intake snapshot
// =====================================================================

import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { col, createdAt, uuidPk } from "./columns";
import {
  actorKindEnum,
  applicationStatusEnum,
  benefitClassEnum,
  budgetBandEnum,
  conditionStabilityEnum,
  intakeSourceEnum,
  maritalStatusEnum,
  priorityTagEnum,
  providerTierEnum,
} from "./enums";
import { appUser, person } from "./identity";

export const application = sqliteTable(
  "application",
  {
    id: uuidPk(),
    reference: text("reference").notNull().unique(), // 'APP-P1'
    personId: text("person_id")
      .notNull()
      .references(() => person.id),
    createdByUserId: text("created_by_user_id") // may be an advisor typing for a caller
      .notNull()
      .references(() => appUser.id),
    intakeSource: text("intake_source", { enum: intakeSourceEnum }).notNull(),
    status: text("status", { enum: applicationStatusEnum }).notNull().default("draft"),

    // snapshot of the applicant AS DECLARED at intake (see SCHEMA.md §2.2)
    age: integer("age").notNull(),
    maritalStatus: text("marital_status", { enum: maritalStatusEnum }),
    smoker: integer("smoker", { mode: "boolean" }),
    emirate: text("emirate"),
    budget: text("budget", { enum: budgetBandEnum }).notNull(),
    policyInception: text("policy_inception").notNull(),
    treatmentOutsideUaeExpected: integer("treatment_outside_uae_expected", { mode: "boolean" })
      .notNull()
      .default(false),

    submittedAt: integer("submitted_at", { mode: "timestamp" }),
    confirmedAt: integer("confirmed_at", { mode: "timestamp" }),
    statusChangedAt: createdAt("status_changed_at"),
    createdAt: createdAt(),
  },
  (table) => [
    index("application_person_id_idx").on(table.personId),
    index("application_status_idx").on(table.status),
    check("application_age_range", sql`${col("age")} between 18 and 100`),
    check(
      "confirmed_needs_timestamp",
      sql`${col("status")} <> 'confirmed' or ${col("confirmed_at")} is not null`,
    ),
  ],
);

// every status move, append-only: who/what moved it, when, and why
export const applicationStatusHistory = sqliteTable(
  "application_status_history",
  {
    id: uuidPk(),
    applicationId: text("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),
    fromStatus: text("from_status", { enum: applicationStatusEnum }),
    toStatus: text("to_status", { enum: applicationStatusEnum }).notNull(),
    changedBy: text("changed_by", { enum: actorKindEnum }).notNull(),
    changedByUserId: text("changed_by_user_id").references(() => appUser.id),
    reason: text("reason"),
    changedAt: createdAt("changed_at"),
  },
  (table) => [index("application_status_history_app_changed_idx").on(table.applicationId, table.changedAt)],
);

// Declared health. Rows, not JSON — every gate queries these. --------
export const applicationCondition = sqliteTable(
  "application_condition",
  {
    id: uuidPk(),
    applicationId: text("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),
    rawText: text("raw_text").notNull(), // exactly what was typed/said
    conditionCode: text("condition_code"), // null => 'condition_uncodable' review flag
    stability: text("stability", { enum: conditionStabilityEnum }).notNull().default("unknown"),
    declaredAtIntake: integer("declared_at_intake", { mode: "boolean" }).notNull().default(true), // read by the adjudicator to pick benefit class
    enteredByUserId: text("entered_by_user_id").references(() => appUser.id),
  },
  (table) => [index("application_condition_application_id_idx").on(table.applicationId)],
);

export const applicationMedication = sqliteTable("application_medication", {
  id: uuidPk(),
  applicationId: text("application_id")
    .notNull()
    .references(() => application.id, { onDelete: "cascade" }),
  rawText: text("raw_text").notNull(),
});

export const applicationProcedure = sqliteTable("application_procedure", {
  id: uuidPk(),
  applicationId: text("application_id")
    .notNull()
    .references(() => application.id, { onDelete: "cascade" }),
  rawText: text("raw_text").notNull(),
  occurredOn: text("occurred_on"),
});

// The block that actually decides the recommendation. ----------------
export const applicationNeed = sqliteTable(
  "application_need",
  {
    id: uuidPk(),
    applicationId: text("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),
    rawText: text("raw_text").notNull(),
    benefitClass: text("benefit_class", { enum: benefitClassEnum }), // null => review flag
    horizonMonths: integer("horizon_months"), // null => BLOCK. Wait-vs-horizon has nothing to compare.
  },
  (table) => [
    index("application_need_application_id_idx").on(table.applicationId),
    check("application_need_horizon_nonneg", sql`${table.horizonMonths} >= 0`),
  ],
);

export const applicationPriority = sqliteTable("application_priority", {
  id: uuidPk(),
  applicationId: text("application_id")
    .notNull()
    .references(() => application.id, { onDelete: "cascade" }),
  rawText: text("raw_text").notNull(),
  tag: text("tag", { enum: priorityTagEnum }).notNull().default("other"),
});

export const applicationExpectedProvider = sqliteTable("application_expected_provider", {
  id: uuidPk(),
  applicationId: text("application_id")
    .notNull()
    .references(() => application.id, { onDelete: "cascade" }),
  providerName: text("provider_name").notNull(),
  tier: text("tier", { enum: providerTierEnum }),
});
