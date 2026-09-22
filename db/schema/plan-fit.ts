// =====================================================================
// 8 · PLAN-FIT REASSESSMENT
// =====================================================================

import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { col, createdAt, uuidPk } from "./columns";
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
    // The events cited in the prose above, structured — not parsed back out of it. The broker text names each by
    // `ref` (CLM-3); the member text names it by `description`, verbatim, so the UI can turn either into a chip
    // that scrolls to the row without guessing where a citation starts and ends in free text.
    citations: text("citations", { mode: "json" }).$type<{ eventId: string; ref: string; description: string }[]>().notNull().default([]),
    createdBy: text("created_by", { enum: actorKindEnum }).notNull().default("system"),
    createdAt: createdAt(),
  },
  (table) => [
    index("plan_fit_reassessment_policy_id_idx").on(table.policyId),
    check(
      "change_needs_target",
      sql`${col("verdict")} <> 'recommend_change' or ${col("recommended_plan_id")} is not null`,
    ),
  ],
);
