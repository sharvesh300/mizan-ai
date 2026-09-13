// =====================================================================
// 9 · CUSTOMER-SAFE VIEWS — the two registers enforced in SQL
//     Nothing from assessment*, review*, or *broker_* columns.
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
import { benefitClassEnum, eventKindEnum, eventOutcomeEnum, policyStatusEnum } from "./enums";

export const customerPolicyView = sqliteView("customer_policy_view", {
  policyId: text("policy_id").notNull(),
  policyNumber: text("policy_number").notNull(),
  inceptionDate: text("inception_date").notNull(),
  status: text("status", { enum: policyStatusEnum }).notNull(),
  planName: text("plan_name").notNull(),
  annualPremium: amount("annual_premium").notNull(),
  fullName: text("full_name").notNull(),
  deductibleMet: amount("deductible_met"),
  annualPaid: amount("annual_paid"),
  sublimitUsed: text("sublimit_used", { mode: "json" }).$type<Record<string, number>>(),
}).as(sql`
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
  planPays: amount("plan_pays"),
  memberPays: amount("member_pays"),
  explanation: text("explanation"),
  calculation: text("calculation", { mode: "json" }).$type<unknown>(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}).as(sql`
  select e.id, e.external_ref, e.policy_id, e.kind, e.policy_month, e.benefit_class,
         e.description, e.billed_amount, e.estimated_amount,
         e.outcome, e.plan_pays, e.member_pays,
         e.member_explanation as explanation,
         e.calculation, e.created_at
  from servicing_event e
`);
