// =====================================================================
// 6 · REVIEW — the worklist and the record of who decided what
// =====================================================================

import { desc } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, uuidPk } from "./columns";
import { reviewActionEnum, reviewStatusEnum, reviewSubjectEnum } from "./enums";
import { appUser } from "./identity";

export const reviewTask = sqliteTable(
  "review_task",
  {
    id: uuidPk(),
    subjectType: text("subject_type", { enum: reviewSubjectEnum }).notNull(),
    subjectId: text("subject_id").notNull(), // polymorphic; see SCHEMA.md §2.6
    reason: text("reason").notNull(),
    priorityScore: integer("priority_score").notNull().default(0), // queue ordering
    status: text("status", { enum: reviewStatusEnum }).notNull().default("open"),
    assignedToUserId: text("assigned_to_user_id").references(() => appUser.id),
    createdAt: createdAt(),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  },
  (table) => [
    index("review_task_status_priority_idx").on(table.status, desc(table.priorityScore)),
    index("review_task_subject_idx").on(table.subjectType, table.subjectId),
  ],
);

export const reviewDecision = sqliteTable(
  "review_decision",
  {
    id: uuidPk(),
    reviewTaskId: text("review_task_id")
      .notNull()
      .references(() => reviewTask.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => appUser.id),
    action: text("action", { enum: reviewActionEnum }).notNull(),
    notes: text("notes"),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(), // the edit itself, when action='edit'
    decidedAt: createdAt("decided_at"),
  },
  (table) => [index("review_decision_review_task_id_idx").on(table.reviewTaskId)],
);
