// =====================================================================
// v2 · 5 · MODEL RUNS & AI DECISIONS
// =====================================================================

import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { amount, createdAt, uuidPk } from "./columns";
import { aiDecisionStatusEnum, aiDecisionTypeEnum, modelRunStatusEnum } from "./enums";
import { conversation } from "./conversation";
import { reviewTask } from "./review";

// the mechanical call
export const modelRun = sqliteTable(
  "model_run",
  {
    id: uuidPk(),
    purpose: text("purpose").notNull(), // matches ai_decision_type, or an internal step name
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    promptVersion: text("prompt_version").notNull(),
    request: text("request", { mode: "json" }).$type<unknown>(), // redacted or a pointer; never PHI in the clear
    response: text("response", { mode: "json" }).$type<unknown>(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: amount("cost_usd"),
    latencyMs: integer("latency_ms"),
    status: text("status", { enum: modelRunStatusEnum }).notNull().default("ok"),
    errorText: text("error_text"),
    createdAt: createdAt(),
  },
  (table) => [index("model_run_created_at_idx").on(table.createdAt)],
);

// the semantic claim the model made
export const aiDecision = sqliteTable(
  "ai_decision",
  {
    id: uuidPk(),
    decisionType: text("decision_type", { enum: aiDecisionTypeEnum }).notNull(),
    subjectType: text("subject_type").notNull(), // 'application' | 'recommendation' | 'servicing_event' | ...
    subjectId: text("subject_id").notNull(),
    conversationId: text("conversation_id").references(() => conversation.id),
    modelRunId: text("model_run_id").references(() => modelRun.id),

    output: text("output", { mode: "json" }).$type<unknown>().notNull(), // the structured proposal
    summary: text("summary"), // one line for the broker worklist
    confidence: amount("confidence"),
    uncertaintyReason: text("uncertainty_reason"), // why this one needs a human, in words
    requiresReview: integer("requires_review", { mode: "boolean" }).notNull().default(false),

    status: text("status", { enum: aiDecisionStatusEnum }).notNull().default("proposed"),
    reviewTaskId: text("review_task_id").references(() => reviewTask.id), // the queue item this created, if any
    appliedToId: text("applied_to_id"), // the v1 row written when accepted
    supersededById: text("superseded_by_id").references((): AnySQLiteColumn => aiDecision.id),
    createdAt: createdAt(),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  },
  (table) => [
    index("ai_decision_subject_idx").on(table.subjectType, table.subjectId),
    index("ai_decision_status_requires_review_idx").on(table.status, table.requiresReview),
    index("ai_decision_type_created_idx").on(table.decisionType, table.createdAt),
    check("ai_decision_confidence_range", sql`${table.confidence} between 0 and 1`),
    // a proposal that admits low confidence cannot also auto-apply
    check(
      "low_confidence_needs_review",
      sql`${table.confidence} is null or ${table.confidence} >= 0.75 or ${table.requiresReview} = true`,
    ),
    check(
      "review_resolution_recorded",
      sql`${table.status} not in ('accepted', 'edited', 'rejected') or ${table.resolvedAt} is not null`,
    ),
  ],
);
