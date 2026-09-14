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
  benefitLedger,
  conversation,
  conversationQuestion,
  extraction,
  plan,
  policy,
  quote,
  recommendation,
  reviewDecision,
  reviewTask,
  type ApplicationStatus,
  type ConfidenceLevel,
} from "@/db/schema";
import { validateAndClassify } from "@/lib/ai/assessment-session";
import { scheduleRecommendation } from "@/lib/ai/recommendation-session";
import { fieldByKey, labelForField } from "@/lib/ai/fields";
import { buildQuestion } from "@/lib/ai/questions";
import { replayFromExtractions, sayAssistant } from "@/lib/ai/intake-session";
import { emptyDraft } from "@/lib/intake";
import { isSelectionReview } from "@/lib/queries";
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
 *
 * Returns the conversation id (or null when there was none) so callers that
 * need to close the thread or revalidate its chat route directly — issuing a
 * policy is the one that does both — do not have to look it up twice.
 */
async function tellApplicant(applicationId: string, text: string, payload?: Record<string, unknown>) {
  const [convo] = await db
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.applicationId, applicationId))
    .orderBy(desc(conversation.startedAt))
    .limit(1);
  if (!convo) return null;

  await sayAssistant(convo.id, text, payload ?? { kind: "advisor_decision" });
  return convo.id;
}

/**
 * `/policies` and `/` are included because `issuePolicy` writes a `policy`
 * row here — without them, the applicant's "My cover" page and dashboard
 * stay on their pre-issuance cache until an unrelated navigation happens to
 * revalidate them.
 */
const revalidate = (applicationId: string, conversationId?: string | null) => {
  revalidatePath(`/applications/${applicationId}`);
  revalidatePath("/applications");
  revalidatePath("/queue");
  revalidatePath("/policies");
  revalidatePath("/");
  if (conversationId) revalidatePath(`/applications/new/chat/${conversationId}`);
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

  // The gate this task opened is now clear — recommendation can start.
  // Scheduled, not awaited: the agent's tool-call loop can take several model
  // round-trips, and the advisor's click should not hang on it — it runs
  // after this response goes out and posts its own chat follow-up when done
  // (lib/ai/recommendation-session.ts's scheduleRecommendation).
  scheduleRecommendation(task.subjectId);

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

  // The gate this task opened is now clear — recommendation can start.
  // Scheduled, not awaited: the agent's tool-call loop can take several model
  // round-trips, and the advisor's click should not hang on it — it runs
  // after this response goes out and posts its own chat follow-up when done
  // (lib/ai/recommendation-session.ts's scheduleRecommendation).
  scheduleRecommendation(task.subjectId);

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

// ---------------------------------------------------------------------------
// Two different questions land on the same `recommendation` row, and a
// review task alone does not say which one an advisor is answering:
//
//   Review 1.5 — an INFORMATIONAL quality check. Opened in
//   lib/ai/recommendation-session.ts in PARALLEL with the applicant already
//   seeing the shortlist card in chat — a fallback, a failed verify, or low
//   confidence. The applicant has not necessarily chosen anything yet, and is
//   never held back for this. It carries no approve/edit/override verb —
//   only `markRecommendationChecked` below — because nothing irreversible (or
//   reversible-but-consequential) belongs on a row the applicant may still
//   walk away from.
//
//   Review 2 — the applicant's own choice, via `pickPlan`
//   (app/applications/new/actions.ts). THIS is what gates policy issuance,
//   and the only place approve/edit/override are reachable at all.
//
// `isSelectionReview` (lib/queries.ts) is the only thing that tells them
// apart — a `select_plan` conversation_action naming this recommendation.
// approve/edit/override each refuse outright when it is false: getting this
// branch wrong is exactly what issued a policy nobody had chosen.
// ---------------------------------------------------------------------------

async function openRecommendationTask(taskId: string) {
  const task = await openTask(taskId);
  const [reco] = await db.select().from(recommendation).where(eq(recommendation.id, task.subjectId)).limit(1);
  if (!reco) throw new Error("Recommendation not found for this task.");
  return { task, reco };
}

/** Same check `pickPlan` (app/applications/new/actions.ts) runs on the applicant's own pick — an advisor swapping the plan is bound by the same panel. */
async function isEligiblePlan(applicationId: string, planId: string): Promise<boolean> {
  const [row] = await db.select({ eligible: quote.eligible }).from(quote).where(and(eq(quote.applicationId, applicationId), eq(quote.planId, planId))).limit(1);
  return Boolean(row?.eligible);
}

/**
 * Review 1.5's only verb. No plan decision to record — just acknowledges an
 * advisor looked at a shortlist the system was not fully confident in, so the
 * audit trail exists without ever blocking the applicant, who already has
 * the cards.
 */
export async function markRecommendationChecked(taskId: string, formData: FormData): Promise<void> {
  const user = await advisorOnly();
  const { task, reco } = await openRecommendationTask(taskId);
  const notes = (formData.get("notes")?.toString() ?? "").trim() || null;
  if (await isSelectionReview(reco.id)) {
    throw new Error("The applicant has already chosen — use Approve, Edit, Override or Reject instead.");
  }

  await db.insert(reviewDecision).values({ reviewTaskId: task.id, actorUserId: user.id, action: "approve", notes });
  await db
    .update(reviewTask)
    .set({ status: "resolved", assignedToUserId: user.id, resolvedAt: new Date() })
    .where(eq(reviewTask.id, task.id));
  await db
    .update(aiDecision)
    .set({ status: "accepted", resolvedAt: new Date() })
    .where(and(eq(aiDecision.reviewTaskId, task.id), eq(aiDecision.status, "proposed")));

  revalidate(reco.applicationId);
}

/** First real writer of `policy`/`benefit_ledger` — nothing else in the app inserts either table. */
async function issuePolicy(input: { applicationId: string; recommendationId: string; planId: string; actorUserId: string }) {
  const [row] = await db
    .select({ policyInception: application.policyInception, personId: application.personId })
    .from(application)
    .where(eq(application.id, input.applicationId))
    .limit(1);
  const [planRow] = await db.select({ name: plan.name, annualPremium: plan.annualPremium }).from(plan).where(eq(plan.id, input.planId)).limit(1);
  if (!row || !planRow) throw new Error("Cannot issue a policy — application or plan not found.");

  const policyNumber = `POL-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const [created] = await db
    .insert(policy)
    .values({
      applicationId: input.applicationId,
      personId: row.personId,
      planId: input.planId,
      recommendationId: input.recommendationId,
      policyNumber,
      inceptionDate: row.policyInception,
      status: "active",
      annualPremium: planRow.annualPremium,
    })
    .returning();

  await db.insert(benefitLedger).values({
    policyId: created.id,
    deductibleMet: 0,
    annualPaid: 0,
    sublimitUsed: { maternity: 0, dental_optical: 0 },
  });

  await moveApplication({
    applicationId: input.applicationId,
    toStatus: "policy_issued",
    actorUserId: input.actorUserId,
    reason: `Policy ${policyNumber} issued — ${input.planId}`,
  });

  // The systematic confirmation — distinct from whatever personal note the
  // advisor added via `tellApplicant`, and sent on EVERY issuing path
  // (approve/edit/override alike), which previously left edit/override
  // silent unless the advisor happened to type a member message. A policy is
  // the last thing that happens to this application, so the thread closes
  // here rather than sitting on `awaiting_review` forever.
  const conversationId = await tellApplicant(
    input.applicationId,
    `Your policy is active — ${planRow.name}, ${policyNumber}.`,
    { kind: "policy_issued", policyId: created.id, policyNumber, planId: input.planId },
  );
  if (conversationId) {
    await db.update(conversation).set({ status: "completed", lastOutboundAt: new Date() }).where(eq(conversation.id, conversationId));
  }

  return { ...created, conversationId };
}

// ---------------------------------------------------------------------------
// Approve — the recommendation stands
// ---------------------------------------------------------------------------

export async function approveRecommendation(taskId: string, formData: FormData): Promise<void> {
  const user = await advisorOnly();
  const { task, reco } = await openRecommendationTask(taskId);
  const notes = (formData.get("notes")?.toString() ?? "").trim() || null;
  if (!(await isSelectionReview(reco.id))) {
    throw new Error("The applicant has not chosen a plan yet — use Mark checked instead.");
  }

  await db.insert(reviewDecision).values({ reviewTaskId: task.id, actorUserId: user.id, action: "approve", notes });
  await db
    .update(reviewTask)
    .set({ status: "resolved", assignedToUserId: user.id, resolvedAt: new Date() })
    .where(eq(reviewTask.id, task.id));
  await db.update(recommendation).set({ status: "approved" }).where(eq(recommendation.id, reco.id));
  await db
    .update(aiDecision)
    .set({ status: "accepted", resolvedAt: new Date() })
    .where(and(eq(aiDecision.reviewTaskId, task.id), eq(aiDecision.status, "proposed")));

  // Review 2 — the applicant chose this plan. This is the irreversible act.
  // The advisor's own note, if any, reads before the systematic "policy
  // active" confirmation that `issuePolicy` sends and closes the thread with.
  if (notes) await tellApplicant(reco.applicationId, `Approved — ${notes}`);
  const issued = await issuePolicy({ applicationId: reco.applicationId, recommendationId: reco.id, planId: reco.planId, actorUserId: user.id });

  revalidate(reco.applicationId, issued.conversationId);
}

// ---------------------------------------------------------------------------
// Edit — a correction in the same direction as the system's
// ---------------------------------------------------------------------------

export async function editRecommendation(taskId: string, formData: FormData): Promise<void> {
  const user = await advisorOnly();
  const { task, reco } = await openRecommendationTask(taskId);

  const planId = (formData.get("planId")?.toString() ?? "").trim() || reco.planId;
  const notes = (formData.get("notes")?.toString() ?? "").trim();
  const memberMessage = (formData.get("memberMessage")?.toString() ?? "").trim();
  if (!notes) throw new Error("Say why you changed it — an unexplained correction is not a decision.");
  if (!(await isSelectionReview(reco.id))) {
    throw new Error("The applicant has not chosen a plan yet — use Mark checked instead.");
  }
  const planChanged = planId !== reco.planId;
  if (planChanged) {
    if (!(await isEligiblePlan(reco.applicationId, planId))) throw new Error("That plan is not on this applicant's panel.");
    if (!memberMessage) throw new Error("You're changing the applicant's plan — say what they'll read about it.");
  }

  await db.update(recommendation).set({ status: "superseded" }).where(eq(recommendation.id, reco.id));
  const [created] = await db
    .insert(recommendation)
    .values({
      applicationId: reco.applicationId,
      planId,
      version: reco.version + 1,
      status: "edited",
      brokerReasoning: notes,
      memberReasoning: memberMessage || reco.memberReasoning,
      confidence: reco.confidence,
      uncertaintyReason: null,
      createdBy: "advisor",
      createdByUserId: user.id,
    })
    .returning();

  await db.insert(reviewDecision).values({
    reviewTaskId: task.id,
    actorUserId: user.id,
    action: "edit",
    notes,
    payload: { from: { planId: reco.planId }, to: { planId } },
  });
  await db
    .update(reviewTask)
    .set({ status: "resolved", assignedToUserId: user.id, resolvedAt: new Date() })
    .where(eq(reviewTask.id, task.id));
  await db
    .update(aiDecision)
    .set({ status: "edited", resolvedAt: new Date() })
    .where(and(eq(aiDecision.reviewTaskId, task.id), eq(aiDecision.status, "proposed")));

  // The advisor's note to the applicant, if any, reads before the systematic
  // "policy active" confirmation `issuePolicy` sends and closes the thread
  // with — required above whenever the plan itself changed.
  if (memberMessage) await tellApplicant(reco.applicationId, memberMessage);
  const issued = await issuePolicy({ applicationId: reco.applicationId, recommendationId: created.id, planId, actorUserId: user.id });

  revalidate(reco.applicationId, issued.conversationId);
}

// ---------------------------------------------------------------------------
// Override — a different call from the system's entirely
// ---------------------------------------------------------------------------

export async function overrideRecommendation(taskId: string, formData: FormData): Promise<void> {
  const user = await advisorOnly();
  const { task, reco } = await openRecommendationTask(taskId);

  const planId = (formData.get("planId")?.toString() ?? "").trim();
  const notes = (formData.get("notes")?.toString() ?? "").trim();
  const memberMessage = (formData.get("memberMessage")?.toString() ?? "").trim();
  if (!planId) throw new Error("Pick the plan you are overriding to.");
  if (!notes) throw new Error("Say why you are overriding it.");
  if (!(await isSelectionReview(reco.id))) {
    throw new Error("The applicant has not chosen a plan yet — use Mark checked instead.");
  }
  if (!(await isEligiblePlan(reco.applicationId, planId))) throw new Error("That plan is not on this applicant's panel.");
  if (planId !== reco.planId && !memberMessage) {
    throw new Error("You're overriding to a different plan — say what the applicant will read about it.");
  }

  await db.update(recommendation).set({ status: "superseded" }).where(eq(recommendation.id, reco.id));
  const [created] = await db
    .insert(recommendation)
    .values({
      applicationId: reco.applicationId,
      planId,
      version: reco.version + 1,
      status: "overridden",
      brokerReasoning: notes,
      memberReasoning: memberMessage || "An advisor has chosen a different plan for you.",
      confidence: null,
      uncertaintyReason: null,
      createdBy: "advisor",
      createdByUserId: user.id,
    })
    .returning();

  await db.insert(reviewDecision).values({
    reviewTaskId: task.id,
    actorUserId: user.id,
    action: "override",
    notes,
    payload: { from: { planId: reco.planId }, to: { planId } },
  });
  await db
    .update(reviewTask)
    .set({ status: "resolved", assignedToUserId: user.id, resolvedAt: new Date() })
    .where(eq(reviewTask.id, task.id));
  await db
    .update(aiDecision)
    .set({ status: "edited", resolvedAt: new Date() })
    .where(and(eq(aiDecision.reviewTaskId, task.id), eq(aiDecision.status, "proposed")));

  if (memberMessage) await tellApplicant(reco.applicationId, memberMessage);
  const issued = await issuePolicy({ applicationId: reco.applicationId, recommendationId: created.id, planId, actorUserId: user.id });

  revalidate(reco.applicationId, issued.conversationId);
}

// ---------------------------------------------------------------------------
// Reject — no cover offered
// ---------------------------------------------------------------------------

export async function rejectRecommendation(taskId: string, formData: FormData): Promise<void> {
  const user = await advisorOnly();
  const { task, reco } = await openRecommendationTask(taskId);

  const notes = (formData.get("notes")?.toString() ?? "").trim();
  const memberMessage = (formData.get("memberMessage")?.toString() ?? "").trim();
  if (!notes) throw new Error("Record why this was rejected.");
  if (!memberMessage) throw new Error("Write what the applicant will read. They are owed an explanation.");

  await db.update(recommendation).set({ status: "superseded" }).where(eq(recommendation.id, reco.id));

  await db.insert(reviewDecision).values({
    reviewTaskId: task.id,
    actorUserId: user.id,
    action: "reject",
    notes,
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

  await moveApplication({ applicationId: reco.applicationId, toStatus: "declined", actorUserId: user.id, reason: notes });
  await tellApplicant(reco.applicationId, memberMessage);

  revalidate(reco.applicationId);
}
