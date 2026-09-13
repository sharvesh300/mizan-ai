// =====================================================================
// 8 · PLAN-FIT REASSESSMENT
// =====================================================================

import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, uuidPk } from "./columns";
import { actorKindEnum, fitVerdictEnum } from "./enums";
import { plan } from "./catalogue";
import { policy, servicingEvent } from "./policy-ledger";

export const planFitReassessment = sqliteTable(
  "plan_fit_reassessment",
  {
    id: uuidPk(),
    policyId: text("policy_id")
      .notNull()
      .references(() => policy.id),
    triggeredByEventId: text("triggered_by_event_id").references(() => servicingEvent.id),
    verdict: text("verdict", { enum: fitVerdictEnum }).notNull(),
    recommendedPlanId: text("recommended_plan_id").references(() => plan.id),
    brokerReasoning: text("broker_reasoning").notNull(),
    memberReasoning: text("member_reasoning").notNull(),
    createdBy: text("created_by", { enum: actorKindEnum }).notNull().default("system"),
    createdAt: createdAt(),
  },
  (table) => [
    index("plan_fit_reassessment_policy_id_idx").on(table.policyId),
    check(
      "change_needs_target",
      sql`${table.verdict} <> 'recommend_change' or ${table.recommendedPlanId} is not null`,
    ),
  ],
);
