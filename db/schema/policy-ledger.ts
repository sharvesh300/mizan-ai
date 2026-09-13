// =====================================================================
// 7 · POLICY, LEDGER, EVENT LOG
// =====================================================================
//
// `servicing_event` is append-only in Postgres via a `BEFORE UPDATE OR DELETE`
// trigger (`forbid_mutation()`). Drizzle's schema DSL has no trigger API, so
// the equivalent SQLite trigger lives in `db/triggers.sql` and is applied by
// `db/client.ts` on connect — see that file for the guard.

import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { amount, createdAt, uuidPk } from "./columns";
import {
  actorKindEnum,
  benefitClassEnum,
  careSettingEnum,
  eventKindEnum,
  eventOutcomeEnum,
  policyStatusEnum,
  providerTierEnum,
  reasonCodeEnum,
} from "./enums";
import { application } from "./application";
import { plan } from "./catalogue";
import { appUser, person } from "./identity";
import { recommendation } from "./quote-recommendation";

export const policy = sqliteTable(
  "policy",
  {
    id: uuidPk(),
    externalRef: text("external_ref").unique(), // 'POL-P1'
    applicationId: text("application_id")
      .notNull()
      .unique()
      .references(() => application.id),
    personId: text("person_id")
      .notNull()
      .references(() => person.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plan.id),
    recommendationId: text("recommendation_id").references(() => recommendation.id),
    policyNumber: text("policy_number").notNull().unique(),
    inceptionDate: text("inception_date").notNull(),
    status: text("status", { enum: policyStatusEnum }).notNull().default("active"),
    annualPremium: amount("annual_premium").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("policy_person_id_idx").on(table.personId)],
);

// THE EVENT LOG IS THE SOURCE OF TRUTH. Append-only (see db/triggers.sql).
export const servicingEvent = sqliteTable(
  "servicing_event",
  {
    id: uuidPk(),
    externalRef: text("external_ref").unique(), // 'CLM-1'
    policyId: text("policy_id")
      .notNull()
      .references(() => policy.id),
    kind: text("kind", { enum: eventKindEnum }).notNull(),
    policyMonth: integer("policy_month").notNull(),
    benefitClass: text("benefit_class", { enum: benefitClassEnum }),
    setting: text("setting", { enum: careSettingEnum }),
    providerTier: text("provider_tier", { enum: providerTierEnum }),
    billedAmount: amount("billed_amount"), // claim / reimbursement
    estimatedAmount: amount("estimated_amount"), // preauth
    description: text("description"),
    evidenceText: text("evidence_text"), // appeals: typed in, free prose
    submittedByUserId: text("submitted_by_user_id").references(() => appUser.id),
    occurredOn: text("occurred_on"),

    // adjudication result
    outcome: text("outcome", { enum: eventOutcomeEnum }),
    reasonCode: text("reason_code", { enum: reasonCodeEnum }),
    planPays: amount("plan_pays"),
    memberPays: amount("member_pays"),
    calculation: text("calculation", { mode: "json" }).$type<unknown>(), // ordered arithmetic trace
    ledgerBefore: text("ledger_before", { mode: "json" }).$type<unknown>(),
    ledgerAfter: text("ledger_after", { mode: "json" }).$type<unknown>(),
    memberExplanation: text("member_explanation"),
    brokerExplanation: text("broker_explanation"),

    decidedBy: text("decided_by", { enum: actorKindEnum }),
    decidedByUserId: text("decided_by_user_id").references(() => appUser.id),
    supersedesEventId: text("supersedes_event_id").references((): AnySQLiteColumn => servicingEvent.id),
    appealOfEventId: text("appeal_of_event_id").references((): AnySQLiteColumn => servicingEvent.id),
    createdAt: createdAt(),
  },
  (table) => [
    index("servicing_event_policy_month_idx").on(table.policyId, table.policyMonth),
    index("servicing_event_policy_created_idx").on(table.policyId, table.createdAt),
    check(
      "amount_matches_kind",
      sql`(${table.kind} = 'preauth' and ${table.estimatedAmount} is not null)
        or (${table.kind} in ('claim', 'reimbursement') and ${table.billedAmount} is not null)
        or (${table.kind} = 'appeal')`,
    ),
  ],
);

// THE LEDGER IS A PROJECTION of the log above. Drop it, replay, rebuild.
export const benefitLedger = sqliteTable("benefit_ledger", {
  policyId: text("policy_id")
    .primaryKey()
    .references(() => policy.id, { onDelete: "cascade" }),
  deductibleMet: amount("deductible_met").notNull().default(0),
  annualPaid: amount("annual_paid").notNull().default(0),
  sublimitUsed: text("sublimit_used", { mode: "json" })
    .$type<Record<string, number>>()
    .notNull()
    .default({ maternity: 0, dental_optical: 0 }),
  lastEventId: text("last_event_id").references(() => servicingEvent.id),
  rebuiltAt: createdAt("rebuilt_at"),
});
