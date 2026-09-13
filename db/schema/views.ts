// =====================================================================
// 9 · CUSTOMER-SAFE VIEWS — the two registers enforced in SQL
//     Nothing from assessment*, review*, *broker_* columns, or the
//     confidence / uncertainty_reason pair — that is routing vocabulary.
//
// Defined with the "manual" view builder (explicit columns + a raw SQL
// body) rather than `.as((qb) => qb.select(...))`: drizzle-kit's DDL
// serializer drops the JS-side `{ alias: column }` select aliases when it
// emits `CREATE VIEW`, which would silently rename every projected column
// to its source-table name. Writing the SQL body verbatim keeps the view's
// column names identical to the source Postgres schema.
// =====================================================================

import { sql } from "drizzle-orm";
import { integer, sqliteView, text } from "drizzle-orm/sqlite-core";
import { amount } from "./columns";
import {
  benefitClassEnum,
  dentalOpticalTierEnum,
  eventKindEnum,
  eventOutcomeEnum,
  networkTierEnum,
  policyStatusEnum,
  reasonCodeEnum,
} from "./enums";

export const customerPolicyView = sqliteView("customer_policy_view", {
  policyId: text("policy_id").notNull(),
  policyNumber: text("policy_number").notNull(),
  inceptionDate: text("inception_date").notNull(),
  status: text("status", { enum: policyStatusEnum }).notNull(),
  planName: text("plan_name").notNull(),
  annualPremium: amount("annual_premium").notNull(),
  fullName: text("full_name").notNull(),

  // Coverage terms (spec §4b: "Plan, coverage terms, premium" — customer yes).
  // Utilization without the terms it is measured against is unreadable: a
  // member seeing `deductible_met: 500` cannot tell whether that is the whole
  // deductible or a third of it.
  deductible: amount("deductible").notNull(),
  outpatientCopayPct: amount("outpatient_copay_pct").notNull(),
  network: text("network", { enum: networkTierEnum }).notNull(),
  networkNote: text("network_note"),
  annualLimit: amount("annual_limit").notNull(),
  dentalOptical: text("dental_optical", { enum: dentalOpticalTierEnum }).notNull(),
  maternityCovered: integer("maternity_covered", { mode: "boolean" }).notNull(),
  maternityWaitingPeriodMonths: integer("maternity_waiting_period_months"),
  maternityLimit: amount("maternity_limit"),
  chronicCovered: integer("chronic_covered", { mode: "boolean" }).notNull(),
  chronicWaitingPeriodMonths: integer("chronic_waiting_period_months"),

  deductibleMet: amount("deductible_met"),
  annualPaid: amount("annual_paid"),
  sublimitUsed: text("sublimit_used", { mode: "json" }).$type<Record<string, number>>(),
}).as(sql`
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
`);

export const customerEventView = sqliteView("customer_event_view", {
  id: text("id").notNull(),
  externalRef: text("external_ref"),
  policyId: text("policy_id").notNull(),
  kind: text("kind", { enum: eventKindEnum }).notNull(),
  policyMonth: integer("policy_month").notNull(),
  benefitClass: text("benefit_class", { enum: benefitClassEnum }),
  description: text("description"),
  billedAmount: amount("billed_amount"),
  estimatedAmount: amount("estimated_amount"),
  outcome: text("outcome", { enum: eventOutcomeEnum }),
  // Spec §4b lists `reason_code` and its explanation as customer-visible, and
  // §5 makes it the thing an appeal argues against — a member cannot contest a
  // denial they can only read as prose.
  reasonCode: text("reason_code", { enum: reasonCodeEnum }),
  planPays: amount("plan_pays"),
  memberPays: amount("member_pays"),
  explanation: text("explanation"),
  calculation: text("calculation", { mode: "json" }).$type<unknown>(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}).as(sql`
  select e.id, e.external_ref, e.policy_id, e.kind, e.policy_month, e.benefit_class,
         e.description, e.billed_amount, e.estimated_amount,
         e.outcome, e.reason_code, e.plan_pays, e.member_pays,
         e.member_explanation as explanation,
         e.calculation, e.created_at
  from servicing_event e
`);
