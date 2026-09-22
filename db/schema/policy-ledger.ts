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
import { amount, col, createdAt, uuidPk } from "./columns";
import {
  actorKindEnum,
  benefitClassEnum,
  careSettingEnum,
  claimProviderTierEnum,
  eventKindEnum,
  eventOutcomeEnum,
  geographyEnum,
  policyStatusEnum,
  reasonCodeEnum,
  settlementStatusEnum,
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
    providerTier: text("provider_tier", { enum: claimProviderTierEnum }),
    // Null or 'abroad' is not a gap in the record — it is the finding. The
    // plan data defines no geographic scope, so anything not in the UAE is
    // undecidable from plan terms and must route to a reviewer.
    geography: text("geography", { enum: geographyEnum }).notNull().default("uae"),
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

    // How settled this adjudication is — broker-only, never projected into
    // customer_event_view. A clean in-network claim and an undecidable
    // foreign one must not arrive in the queue looking equally resolved.
    confidence: amount("confidence"), // 0..1
    uncertaintyReason: text("uncertainty_reason"), // why this one needs a human, in words

    decidedBy: text("decided_by", { enum: actorKindEnum }),
    decidedByUserId: text("decided_by_user_id").references(() => appUser.id),
    supersedesEventId: text("supersedes_event_id").references((): AnySQLiteColumn => servicingEvent.id),
    appealOfEventId: text("appeal_of_event_id").references((): AnySQLiteColumn => servicingEvent.id),
    createdAt: createdAt(),
  },
  (table) => [
    index("servicing_event_policy_month_idx").on(table.policyId, table.policyMonth),
    index("servicing_event_policy_created_idx").on(table.policyId, table.createdAt),
    check("servicing_event_confidence_range", sql`${col("confidence")} between 0 and 1`),
    check(
      "amount_matches_kind",
      sql`(${col("kind")} = 'preauth' and ${col("estimated_amount")} is not null)
        or (${col("kind")} in ('claim', 'reimbursement') and ${col("billed_amount")} is not null)
        or (${col("kind")} = 'appeal')`,
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

/**
 * WHAT WAS ACTUALLY PAID — deliberately not part of the event log above.
 *
 * Adjudication decides what the plan OWES; the ledger projects that. Neither says whether the money left. This
 * table is the third thing: a record of a payout, approved by a person and then marked paid by one.
 *
 * It is a separate table rather than columns on `servicing_event` for a reason the database itself enforces —
 * that log is append-only (see `db/triggers.sql`), so a settlement that changes state twice could not live on
 * it. Keeping them apart also keeps the invariant clean: a settlement NEVER moves a ledger and never changes a
 * replay. Drop every settlement row and replay still produces the same deductible, annual total and outcomes.
 *
 * `amount` is stored, not derived on read, and it is written from the ENGINE's own figure at approval time,
 * never typed by a person. A payment made for 2,000 was made for 2,000 forever: if the event is later overturned
 * the new decision gets its own settlement, and this row stays true about what actually happened.
 */
export const claimSettlement = sqliteTable(
  "claim_settlement",
  {
    id: uuidPk(),
    // One payout per decided event. The unique constraint is the idempotency guard: a retried commit, or two
    // requests racing, cannot open two payouts for the same claim.
    servicingEventId: text("servicing_event_id")
      .notNull()
      .unique()
      .references(() => servicingEvent.id),
    policyId: text("policy_id")
      .notNull()
      .references(() => policy.id),
    status: text("status", { enum: settlementStatusEnum }).notNull().default("awaiting_approval"),
    amount: amount("amount").notNull(),
    approvedByUserId: text("approved_by_user_id").references(() => appUser.id),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    paidByUserId: text("paid_by_user_id").references(() => appUser.id),
    paidAt: integer("paid_at", { mode: "timestamp" }),
    /** The advisor's own reference from whatever actually moved the money. Broker-only: never shown to a member. */
    paymentReference: text("payment_reference"),
    createdAt: createdAt(),
  },
  (table) => [
    index("claim_settlement_policy_id_idx").on(table.policyId),
    index("claim_settlement_status_idx").on(table.status),
    // A payout is worth nothing if it is for nothing: the engine only ever opens one when the plan owes money.
    check("claim_settlement_amount_positive", sql`${col("amount")} > 0`),
  ],
);
