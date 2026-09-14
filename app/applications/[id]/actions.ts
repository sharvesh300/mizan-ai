"use server";

// The advisor's decisions on an application.
//
// Four verbs, and the difference between them is the point:
//
//   approve       the classification stands — carry on to quoting
//   edit          the cohort or confidence was wrong; record BOTH, the
//                 system's claim and the correction
//   reject        no cover offered on this application
//   request_info  the record is not answerable as it stands — ask the
//                 applicant for exactly the missing piece, and nothing else
//
// Two of them speak to the applicant, and those two take TWO texts: `notes`
// in the broker register (what a colleague needs to know) and a member
// message in theirs (what this means for them and what happens next). Writing
// one and showing it twice is what makes a system read wrong in one of the
// views, and "reject" is the worst possible place to get that wrong.
//
// Every decision is append-only: `review_decision` records who, what, when and
// why, and the assessment history keeps the system's original claim next to
// the human's correction. Nothing here rewrites what the system said.

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import {
  aiDecision,
  application,
  applicationStatusHistory,
  assessment,
  assessmentFlag,
  conversation,
  conversationQuestion,
  extraction,
  reviewDecision,
  reviewTask,
  type ApplicationStatus,
  type ConfidenceLevel,
} from "@/db/schema";
import { validateAndClassify } from "@/lib/ai/assessment-session";
import { fieldByKey, labelForField } from "@/lib/ai/fields";
import { buildQuestion } from "@/lib/ai/questions";
import { replayFromExtractions, sayAssistant } from "@/lib/ai/intake-session";
import { emptyDraft } from "@/lib/intake";
import { getCurrentUser } from "@/lib/session";

/** Only an advisor decides. Anything else is a bug or a forged form post. */
async function advisorOnly() {
  const user = await getCurrentUser();
  if (!user || user.role !== "advisor") throw new Error("Only an advisor can decide a review task.");
  return user;
}

async function openTask(taskId: string) {
  const [task] = await db.select().from(reviewTask).where(eq(reviewTask.id, taskId)).limit(1);
  if (!task) throw new Error("Review task not found.");
  if (task.status === "resolved") throw new Error("That task has already been decided.");
  return task;
}

/** Move the application and leave the trail that says who moved it and why. */
async function moveApplication(input: {
  applicationId: string;
  toStatus: ApplicationStatus;
  actorUserId: string;
  reason: string;
}) {
  const [current] = await db
    .select({ status: application.status })
    .from(application)
    .where(eq(application.id, input.applicationId))
    .limit(1);

  await db
    .update(application)
    .set({ status: input.toStatus, statusChangedAt: new Date() })
    .where(eq(application.id, input.applicationId));

  await db.insert(applicationStatusHistory).values({
    applicationId: input.applicationId,
    fromStatus: current?.status ?? null,
    toStatus: input.toStatus,
    changedBy: "advisor",
    changedByUserId: input.actorUserId,
    reason: input.reason,
  });
}

/**
 * Say something to the applicant, in their own conversation.
 *
 * Their intake chat is where they already are, so a decision lands in the
 * thread they had with us rather than in a notification with no context. A
 * form application has no conversation, and that is fine — the message is
 * still on the decision row, and the application page renders it.
 */
async function tellApplicant(applicationId: string, text: string) {
  const [convo] = await db
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.applicationId, applicationId))
    .orderBy(desc(conversation.startedAt))
    .limit(1);
  if (!convo) return null;

  await sayAssistant(convo.id, text, { kind: "advisor_decision" });
  return convo.id;
}

const revalidate = (applicationId: string) => {
  revalidatePath(`/applications/${applicationId}`);
  revalidatePath("/applications");
  revalidatePath("/queue");
};

// ---------------------------------------------------------------------------
// Approve — the classification stands
// ---------------------------------------------------------------------------

export async function approveAssessment(taskId: string, formData: FormData): Promise<void> {
  const user = await advisorOnly();
  const task = await openTask(taskId);
  const notes = (formData.get("notes")?.toString() ?? "").trim() || null;

  await db.insert(reviewDecision).values({
    reviewTaskId: task.id,
    actorUserId: user.id,
    action: "approve",
    notes,
  });
  await db
    .update(reviewTask)
    .set({ status: "resolved", assignedToUserId: user.id, resolvedAt: new Date() })
    .where(eq(reviewTask.id, task.id));

  // The claim the system made is now a decision a person stands behind.
  await db
    .update(aiDecision)
    .set({ status: "accepted", resolvedAt: new Date() })
    .where(and(eq(aiDecision.reviewTaskId, task.id), eq(aiDecision.status, "proposed")));

  await moveApplication({
    applicationId: task.subjectId,
    toStatus: "assessed",
    actorUserId: user.id,
    reason: notes ? `Assessment approved — ${notes}` : "Assessment approved by advisor",
  });

  revalidate(task.subjectId);
}

// ---------------------------------------------------------------------------
// Edit — the cohort was wrong
// ---------------------------------------------------------------------------

/**
 * A corrected assessment is a NEW row, never an overwrite.
 *
 * `getAssessment` reads the latest, so the correction is what the app shows —
 * and the system's original claim is still there, next to it, which is the
 * only way anyone can later tell whether the rules or the advisor was right.
 * The flags are copied forward: an advisor disagreeing with a cohort is not
 * saying the constraints did not fire.
 */
export async function editAssessment(taskId: string, formData: FormData): Promise<void> {
  const user = await advisorOnly();
  const task = await openTask(taskId);

  const cohort = (formData.get("cohort")?.toString() ?? "").trim();
  const confidence = (formData.get("confidence")?.toString() ?? "") as ConfidenceLevel;
  const notes = (formData.get("notes")?.toString() ?? "").trim();
  if (!cohort) throw new Error("A cohort is required.");
  if (!notes) throw new Error("Say why you changed it — an unexplained override is not a decision.");

  const [previous] = await db
    .select()
    .from(assessment)
    .where(eq(assessment.applicationId, task.subjectId))
    .orderBy(desc(assessment.createdAt))
    .limit(1);

  const [created] = await db
    .insert(assessment)
    .values({
      applicationId: task.subjectId,
      cohort,
      confidence: confidence || previous?.confidence || "medium",
      createdBy: "advisor",
      createdByUserId: user.id,
    })
    .returning();

  if (previous) {
    const flags = await db.select().from(assessmentFlag).where(eq(assessmentFlag.assessmentId, previous.id));
    if (flags.length > 0) {
      await db.insert(assessmentFlag).values(
        flags.map((flag) => ({
          assessmentId: created.id,
          ruleCode: flag.ruleCode,
          severity: flag.severity,
          fields: flag.fields,
          reason: flag.reason,
        })),
      );
    }
  }

  await db.insert(reviewDecision).values({
    reviewTaskId: task.id,
    actorUserId: user.id,
    action: "edit",
    notes,
    payload: { from: { cohort: previous?.cohort, confidence: previous?.confidence }, to: { cohort, confidence } },
  });
  await db
    .update(reviewTask)
    .set({ status: "resolved", assignedToUserId: user.id, resolvedAt: new Date() })
    .where(eq(reviewTask.id, task.id));
  await db
    .update(aiDecision)
    .set({ status: "edited", resolvedAt: new Date() })
    .where(and(eq(aiDecision.reviewTaskId, task.id), eq(aiDecision.status, "proposed")));

  await moveApplication({
    applicationId: task.subjectId,
    toStatus: "assessed",
    actorUserId: user.id,
    reason: `Cohort changed to ${cohort} — ${notes}`,
  });

  revalidate(task.subjectId);
}

// ---------------------------------------------------------------------------
// Reject — no cover offered
// ---------------------------------------------------------------------------

export async function rejectApplication(taskId: string, formData: FormData): Promise<void> {
  const user = await advisorOnly();
  const task = await openTask(taskId);

  const notes = (formData.get("notes")?.toString() ?? "").trim();
  const memberMessage = (formData.get("memberMessage")?.toString() ?? "").trim();
  if (!notes) throw new Error("Record why this was rejected.");
  if (!memberMessage) throw new Error("Write what the applicant will read. They are owed an explanation.");

  await db.insert(reviewDecision).values({
    reviewTaskId: task.id,
    actorUserId: user.id,
    action: "reject",
    notes,
    // The member register lives on the decision, not only in a chat message,
    // so the application page can render it whatever surface intake came from.
    payload: { memberMessage },
  });
  await db
    .update(reviewTask)
    .set({ status: "resolved", assignedToUserId: user.id, resolvedAt: new Date() })
    .where(eq(reviewTask.id, task.id));
  await db
    .update(aiDecision)
    .set({ status: "rejected", resolvedAt: new Date() })
    .where(and(eq(aiDecision.reviewTaskId, task.id), eq(aiDecision.status, "proposed")));

  await moveApplication({
    applicationId: task.subjectId,
    toStatus: "declined",
    actorUserId: user.id,
    reason: notes,
  });
  await tellApplicant(task.subjectId, memberMessage);

  revalidate(task.subjectId);
}

// ---------------------------------------------------------------------------
// Request info — ask for the missing piece, and only that
// ---------------------------------------------------------------------------

/**
 * Put the application back in front of the applicant with a short list of
 * questions on it.
 *
 * The point of the whole system is that nothing already known is asked for
 * twice, so this opens question rows for the named fields ONLY and reopens
 * their existing conversation. They see the advisor's message and the two
 * boxes it needs — not intake again from the top.
 */
export async function requestInfo(taskId: string, formData: FormData): Promise<void> {
  const user = await advisorOnly();
  const task = await openTask(taskId);

  const fieldKeys = formData
    .getAll("fieldKeys")
    .map((value) => value.toString())
    .filter((key) => Boolean(fieldByKey(key)));
  const notes = (formData.get("notes")?.toString() ?? "").trim();
  const memberMessage = (formData.get("memberMessage")?.toString() ?? "").trim();
  if (fieldKeys.length === 0) throw new Error("Pick at least one thing to ask for.");
  if (!memberMessage) throw new Error("Write what the applicant will read.");

  await db.insert(reviewDecision).values({
    reviewTaskId: task.id,
    actorUserId: user.id,
    action: "request_info",
    notes: notes || `Asked the applicant for: ${fieldKeys.map(labelForField).join(", ")}`,
    payload: { memberMessage, fieldKeys },
  });

  // The task stays OPEN. Nothing has been decided — the advisor is waiting on
  // an answer, and a queue that hides what it is waiting for loses track of it.
  await db
    .update(reviewTask)
    .set({ status: "in_progress", assignedToUserId: user.id })
    .where(eq(reviewTask.id, task.id));

  await moveApplication({
    applicationId: task.subjectId,
    toStatus: "in_intake",
    actorUserId: user.id,
    reason: `More information requested: ${fieldKeys.map(labelForField).join(", ")}`,
  });

  const [convo] = await db
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.applicationId, task.subjectId))
    .orderBy(desc(conversation.startedAt))
    .limit(1);

  if (convo) {
    // Replay the draft so the questions are worded against what they already
    // told us ("Is Meera's diabetes managed?", not "Is the condition managed?").
    const rows = await db
      .select()
      .from(extraction)
      .where(eq(extraction.conversationId, convo.id))
      .orderBy(asc(extraction.createdAt));
    const draft = rows.length > 0 ? replayFromExtractions(rows) : emptyDraft();

    const questions = fieldKeys.map((key) => buildQuestion(key, draft));
    const asked = await sayAssistant(convo.id, memberMessage, { kind: "questionnaire", questions });

    // Supersede anything still open: the advisor's list is now the ask.
    const stale = await db
      .select({ id: conversationQuestion.id })
      .from(conversationQuestion)
      .where(and(eq(conversationQuestion.conversationId, convo.id), eq(conversationQuestion.status, "asked")));
    if (stale.length > 0) {
      await db
        .update(conversationQuestion)
        .set({ status: "superseded", resolvedAt: new Date() })
        .where(inArray(conversationQuestion.id, stale.map((q) => q.id)));
    }

    for (const question of questions) {
      const field = fieldByKey(question.fieldKey);
      await db.insert(conversationQuestion).values({
        conversationId: convo.id,
        askedMessageId: asked.id,
        fieldKey: question.fieldKey,
        targetTable: field?.table ?? null,
        targetColumn: field?.column ?? null,
        severity: question.severity,
        questionText: question.questionText,
        triggerRule: "advisor:request_info",
        status: "asked",
      });
    }

    await db
      .update(conversation)
      .set({ status: "awaiting_user", closedAt: null, lastOutboundAt: new Date() })
      .where(eq(conversation.id, convo.id));
  }

  revalidate(task.subjectId);
}

// ---------------------------------------------------------------------------
// Re-run the rules
// ---------------------------------------------------------------------------

/**
 * Assess the record again — after an edit to the declared data, or after the
 * rules themselves have changed. Writes a fresh assessment; the previous one
 * stays in the history.
 */
export async function reclassify(applicationId: string): Promise<void> {
  await advisorOnly();
  await validateAndClassify(applicationId, { force: true });
  revalidate(applicationId);
}
