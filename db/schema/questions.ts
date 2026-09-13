// =====================================================================
// v2 · 3 · QUESTIONS — what the assistant asked, and what came back
// =====================================================================

import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { conversation, message } from "./conversation";
import { col, createdAt, uuidPk } from "./columns";
import { flagSeverityEnum, questionStatusEnum } from "./enums";

export const conversationQuestion = sqliteTable(
  "conversation_question",
  {
    id: uuidPk(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    askedMessageId: text("asked_message_id").references(() => message.id),
    answeredMessageId: text("answered_message_id").references(() => message.id),

    fieldKey: text("field_key").notNull(), // 'need.horizon_months' — stable across surfaces
    targetTable: text("target_table"), // where the answer lands
    targetColumn: text("target_column"),
    targetRowId: text("target_row_id"),
    triggerRule: text("trigger_rule"), // INTAKE_VALIDATION.md §6.2 trigger that fired
    severity: text("severity", { enum: flagSeverityEnum }).notNull(), // block / review / warn — decides re-ask policy

    questionText: text("question_text").notNull(),
    status: text("status", { enum: questionStatusEnum }).notNull().default("asked"),
    askCount: integer("ask_count").notNull().default(1),
    answerRaw: text("answer_raw"),
    askedAt: createdAt("asked_at"),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  },
  (table) => [
    index("conversation_question_conversation_status_idx").on(table.conversationId, table.status),
    index("conversation_question_field_key_idx").on(table.fieldKey),
    check("conversation_question_ask_count_max", sql`${col("ask_count")} <= 2`),
    check(
      "answered_has_answer",
      sql`${col("status")} <> 'answered' or ${col("answered_message_id")} is not null`,
    ),
  ],
);
