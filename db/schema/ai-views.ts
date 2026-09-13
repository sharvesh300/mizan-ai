// =====================================================================
// v2 · 7 · CONVENIENCE VIEWS
//
// Manual view builder (explicit columns + raw SQL body) — see the note in
// views.ts for why: drizzle-kit drops select-aliases for `.as((qb) => …)`.
// =====================================================================

import { sql } from "drizzle-orm";
import { integer, sqliteView, text } from "drizzle-orm/sqlite-core";
import { amount } from "./columns";
import { aiDecisionTypeEnum, channelEnum, extractionMethodEnum, reviewStatusEnum } from "./enums";

// everything a broker needs to judge one AI proposal
export const aiReviewQueue = sqliteView("ai_review_queue", {
  aiDecisionId: text("ai_decision_id").notNull(),
  decisionType: text("decision_type", { enum: aiDecisionTypeEnum }).notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  summary: text("summary"),
  confidence: amount("confidence"),
  uncertaintyReason: text("uncertainty_reason"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  reviewTaskId: text("review_task_id"),
  priorityScore: integer("priority_score"),
  reviewStatus: text("review_status", { enum: reviewStatusEnum }),
  modelId: text("model_id"),
  promptVersion: text("prompt_version"),
}).as(sql`
  select d.id            as ai_decision_id,
         d.decision_type,
         d.subject_type, d.subject_id,
         d.summary, d.confidence, d.uncertainty_reason,
         d.created_at,
         r.id            as review_task_id,
         r.priority_score,
         r.status        as review_status,
         m.model_id, m.prompt_version
  from ai_decision d
  left join review_task r on r.id = d.review_task_id
  left join model_run  m on m.id = d.model_run_id
  where d.status = 'proposed' and d.requires_review
`);

// provenance for one application: field, the sentence behind it, how it got there
export const applicationFieldProvenance = sqliteView("application_field_provenance", {
  targetTable: text("target_table").notNull(),
  targetColumn: text("target_column").notNull(),
  targetRowId: text("target_row_id"),
  fieldKey: text("field_key").notNull(),
  valueText: text("value_text"),
  rawSpan: text("raw_span").notNull(),
  method: text("method", { enum: extractionMethodEnum }).notNull(),
  confidence: amount("confidence"),
  channel: text("channel", { enum: channelEnum }).notNull(),
  conversationId: text("conversation_id").notNull(),
  saidAt: integer("said_at", { mode: "timestamp" }),
}).as(sql`
  select e.target_table, e.target_column, e.target_row_id,
         e.field_key, e.value_text, e.raw_span, e.method, e.confidence,
         c.channel, c.id as conversation_id, msg.provider_timestamp as said_at
  from extraction e
  join conversation c on c.id = e.conversation_id
  left join message msg on msg.id = e.message_id
`);
