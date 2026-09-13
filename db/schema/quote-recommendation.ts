// =====================================================================
// 5 · QUOTE & RECOMMENDATION — every plan scored, not just the winner
// =====================================================================

import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
import { amount, col, createdAt, uuidPk } from "./columns";
import { actorKindEnum, recoStatusEnum } from "./enums";
import { application } from "./application";
import { plan } from "./catalogue";
import { appUser } from "./identity";

export const quote = sqliteTable(
  "quote",
  {
    id: uuidPk(),
    applicationId: text("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),
    planId: text("plan_id")
      .notNull()
      .references(() => plan.id),
    annualPremium: amount("annual_premium").notNull(), // priced at quote time, not read live from plan
    eligible: integer("eligible", { mode: "boolean" }).notNull().default(true),
    rank: integer("rank"),
    score: amount("score"),
    createdAt: createdAt(),
  },
  (table) => [unique("quote_application_id_plan_id_key").on(table.applicationId, table.planId)],
);

export const recommendation = sqliteTable(
  "recommendation",
  {
    id: uuidPk(),
    applicationId: text("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),
    planId: text("plan_id")
      .notNull()
      .references(() => plan.id),
    version: integer("version").notNull().default(1),
    status: text("status", { enum: recoStatusEnum }).notNull().default("pending_review"),
    brokerReasoning: text("broker_reasoning").notNull(), // two registers, two columns
    memberReasoning: text("member_reasoning").notNull(),

    // Broker-only. Not every recommendation is equally settled: P1 -> Essential
    // is obvious, P3 is genuinely arguable between Balanced and Comprehensive.
    // A queue that renders both at the same confidence gets rubber-stamped.
    // Never projected into a customer-facing view — the member sees the
    // recommendation and why it fits them, not how sure the system was.
    confidence: amount("confidence"), // 0..1
    uncertaintyReason: text("uncertainty_reason"), // what makes this a close call, in words
    createdBy: text("created_by", { enum: actorKindEnum }).notNull().default("system"),
    createdByUserId: text("created_by_user_id").references(() => appUser.id),
    createdAt: createdAt(),
  },
  (table) => [
    unique("recommendation_application_id_version_key").on(table.applicationId, table.version),
    check("recommendation_confidence_range", sql`${col("confidence")} between 0 and 1`),
    // at most one live recommendation per application
    uniqueIndex("one_live_recommendation")
      .on(table.applicationId)
      .where(sql`${table.status} in ('pending_review', 'approved', 'edited', 'overridden')`),
  ],
);

// why the other plans lost — the broker view needs the alternatives
export const recommendationRejection = sqliteTable(
  "recommendation_rejection",
  {
    id: uuidPk(),
    recommendationId: text("recommendation_id")
      .notNull()
      .references(() => recommendation.id, { onDelete: "cascade" }),
    planId: text("plan_id")
      .notNull()
      .references(() => plan.id),
    reason: text("reason").notNull(),
  },
  (table) => [unique("recommendation_rejection_recommendation_id_plan_id_key").on(table.recommendationId, table.planId)],
);
