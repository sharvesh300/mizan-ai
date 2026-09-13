// =====================================================================
// v2 · 6 · EXTRACTION — which sentence became which field
// =====================================================================

import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { aiDecision } from "./ai-decision";
import { amount, col, createdAt, uuidPk } from "./columns";
import { conversation, message } from "./conversation";
import { extractionMethodEnum } from "./enums";
import { conversationQuestion } from "./questions";

// the rule from INTAKE_VALIDATION.md §4, enforced in the database: a gating
// field may be stated or normalised. It may never be inferred.
const gatedFieldKeys = [
  "application.age",
  "application.smoker",
  "application.budget",
  "application.policy_inception",
  "application.marital_status",
  "condition.raw_text",
  "condition.stability",
  "need.benefit_class",
  "need.horizon_months",
] as const;

export const extraction = sqliteTable(
  "extraction",
  {
    id: uuidPk(),
    aiDecisionId: text("ai_decision_id").references(() => aiDecision.id),
    conversationId: text("conversation_id").references(() => conversation.id),
    messageId: text("message_id").references(() => message.id),
    questionId: text("question_id").references(() => conversationQuestion.id),

    fieldKey: text("field_key").notNull(), // 'condition.stability'
    targetTable: text("target_table").notNull(),
    targetColumn: text("target_column").notNull(),
    targetRowId: text("target_row_id"),

    rawSpan: text("raw_span").notNull(), // the applicant's own words
    spanStart: integer("span_start"),
    spanEnd: integer("span_end"),
    valueText: text("value_text"), // normalised value written to the column
    method: text("method", { enum: extractionMethodEnum }).notNull(),
    confidence: amount("confidence"),
    createdAt: createdAt(),
  },
  (table) => [
    index("extraction_target_table_row_idx").on(table.targetTable, table.targetRowId),
    index("extraction_conversation_id_idx").on(table.conversationId),
    check("extraction_confidence_range", sql`${col("confidence")} between 0 and 1`),
    check(
      "no_inference_on_gated_fields",
      sql`${col("method")} <> 'inferred' or ${col("field_key")} not in (${sql.raw(
        gatedFieldKeys.map((key) => `'${key}'`).join(", "),
      )})`,
    ),
  ],
);
