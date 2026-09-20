// =====================================================================
// v2 · 4 · ACTIONS — what the conversation actually did to the record
//
// Postgres adds the `ai_decision_id` FK via `ALTER TABLE` after `ai_decision`
// exists (section 5 is defined after section 4 in the source script). There
// is no actual cycle — `ai_decision` never references `conversation_action`
// — so the reference is declared directly here.
// =====================================================================

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { aiDecision } from "./ai-decision";
import { actorKindEnum, actionStatusEnum } from "./enums";
import { conversation, message } from "./conversation";
import { createdAt, uuidPk } from "./columns";
import { appUser } from "./identity";

export const conversationAction = sqliteTable(
  "conversation_action",
  {
    id: uuidPk(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    triggeredByMessageId: text("triggered_by_message_id").references(() => message.id),
    aiDecisionId: text("ai_decision_id").references(() => aiDecision.id),

    actionType: text("action_type").notNull(), // 'create_application', 'submit_claim', 'escalate_to_advisor'
    toolName: text("tool_name"), // the function actually invoked
    arguments: text("arguments", { mode: "json" }).$type<unknown>(),
    status: text("status", { enum: actionStatusEnum }).notNull().default("pending"),

    subjectType: text("subject_type"), // table the action wrote to
    subjectId: text("subject_id"), // row it created or changed
    result: text("result", { mode: "json" }).$type<unknown>(),
    errorText: text("error_text"),

    actorKind: text("actor_kind", { enum: actorKindEnum }).notNull(), // system | advisor | applicant
    actorUserId: text("actor_user_id").references(() => appUser.id),
    idempotencyKey: text("idempotency_key").unique(), // replayed webhook must not double-write
    createdAt: createdAt(),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (table) => [
    index("conversation_action_conversation_created_idx").on(table.conversationId, table.createdAt),
    index("conversation_action_subject_idx").on(table.subjectType, table.subjectId),
    // At most one clarifying question, ever, per application — and at most one
    // answer to it — enforced here rather than only in application logic, so
    // two racing workers cannot both write one (lib/ai/graph/nodes/clarify.ts,
    // app/applications/new/actions.ts's sendChatMessage). Same partial-unique-
    // index pattern `one_live_recommendation` already uses on `recommendation`
    // (db/schema/quote-recommendation.ts).
    uniqueIndex("one_clarify_asked_per_application")
      .on(table.subjectId)
      .where(sql`${table.subjectType} = 'application' and ${table.actionType} = 'recommendation_clarify_asked'`),
    uniqueIndex("one_clarify_answer_per_application")
      .on(table.subjectId)
      .where(sql`${table.subjectType} = 'application' and ${table.actionType} = 'recommendation_clarify_answered'`),
    // Same guarantee for the trade-off question (lib/ai/graph/nodes/tradeoff.ts):
    // an applicant is asked which side of a hard gate they want ONCE, and
    // their answer is turned into weights once, however many times the
    // background job is retried or however fast they reply twice.
    uniqueIndex("one_tradeoff_asked_per_application")
      .on(table.subjectId)
      .where(sql`${table.subjectType} = 'application' and ${table.actionType} = 'recommendation_tradeoff_asked'`),
    uniqueIndex("one_tradeoff_answer_per_application")
      .on(table.subjectId)
      .where(sql`${table.subjectType} = 'application' and ${table.actionType} = 'recommendation_tradeoff_answered'`),
  ],
);
