// =====================================================================
// 4 · ASSESSMENT — broker-only. Never joined into the customer view.
// =====================================================================

import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, uuidPk } from "./columns";
import { actorKindEnum, confidenceLevelEnum, flagSeverityEnum } from "./enums";
import { application } from "./application";
import { appUser } from "./identity";

export const assessment = sqliteTable(
  "assessment",
  {
    id: uuidPk(),
    applicationId: text("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),
    cohort: text("cohort").notNull(), // e.g. 'chronic_managed_senior'
    confidence: text("confidence", { enum: confidenceLevelEnum }).notNull(),
    createdBy: text("created_by", { enum: actorKindEnum }).notNull().default("system"),
    createdByUserId: text("created_by_user_id").references(() => appUser.id),
    createdAt: createdAt(),
  },
  (table) => [index("assessment_application_id_idx").on(table.applicationId)],
);

export const assessmentFlag = sqliteTable(
  "assessment_flag",
  {
    id: uuidPk(),
    assessmentId: text("assessment_id")
      .notNull()
      .references(() => assessment.id, { onDelete: "cascade" }),
    ruleCode: text("rule_code").notNull(), // 'need_class_excluded_at_budget'
    severity: text("severity", { enum: flagSeverityEnum }).notNull(),
    fields: text("fields", { mode: "json" }).$type<string[]>().notNull().default([]),
    reason: text("reason").notNull(), // broker register only
  },
  (table) => [index("assessment_flag_assessment_id_idx").on(table.assessmentId)],
);
