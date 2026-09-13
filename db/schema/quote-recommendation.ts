// =====================================================================
// 5 · QUOTE & RECOMMENDATION — every plan scored, not just the winner
// =====================================================================

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
import { amount, createdAt, uuidPk } from "./columns";
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
    createdBy: text("created_by", { enum: actorKindEnum }).notNull().default("system"),
    createdByUserId: text("created_by_user_id").references(() => appUser.id),
    createdAt: createdAt(),
  },
  (table) => [
    unique("recommendation_application_id_version_key").on(table.applicationId, table.version),
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
