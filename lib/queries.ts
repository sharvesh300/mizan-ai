// Read layer. Everything the UI renders comes from here, so the two audiences
// stay honest: the applicant-facing helpers never select a broker-only column
// (cohort, flags, reviewer decisions, confidence), and the broker helpers
// return the whole record.

import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db/client";
import {
  aiDecision,
  application,
  applicationCondition,
  applicationExpectedProvider,
  applicationNeed,
  applicationPriority,
  applicationStatusHistory,
  appUser,
  assessment,
  assessmentFlag,
  benefitLedger,
  conversation,
  conversationQuestion,
  message,
  person,
  plan,
  planFitReassessment,
  policy,
  quote,
  recommendation,
  recommendationRejection,
  reviewDecision,
  reviewTask,
  servicingEvent,
} from "@/db/schema";

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

/** Applications owned by this user (their own + any dependants they hold). */
export async function listApplicationsForUser(userId: string) {
  return db
    .select({
      id: application.id,
      reference: application.reference,
      status: application.status,
      intakeSource: application.intakeSource,
      createdAt: application.createdAt,
      statusChangedAt: application.statusChangedAt,
      personName: person.fullName,
      relationship: person.relationshipToOwner,
      planName: plan.name,
      policyId: policy.id,
    })
    .from(application)
    .innerJoin(person, eq(application.personId, person.id))
    .leftJoin(policy, eq(policy.applicationId, application.id))
    .leftJoin(plan, eq(policy.planId, plan.id))
    .where(eq(person.ownerUserId, userId))
    .orderBy(desc(application.createdAt));
}

/**
 * Every application, for the advisor's pipeline board.
 *
 * An application can carry more than one assessment — an advisor correcting a
 * cohort appends rather than overwrites — so the join is de-duplicated to the
 * newest one per application. Without that, correcting a cohort makes the
 * application appear twice in the pipeline, once under each label.
 */
export async function listAllApplications() {
  const rows = await db
    .select({
      id: application.id,
      reference: application.reference,
      status: application.status,
      intakeSource: application.intakeSource,
      age: application.age,
      budget: application.budget,
      createdAt: application.createdAt,
      statusChangedAt: application.statusChangedAt,
      personName: person.fullName,
      ownerName: appUser.fullName,
      cohort: assessment.cohort,
      confidence: assessment.confidence,
      assessedAt: assessment.createdAt,
      planName: plan.name,
      policyId: policy.id,
    })
    .from(application)
    .innerJoin(person, eq(application.personId, person.id))
    .innerJoin(appUser, eq(person.ownerUserId, appUser.id))
    .leftJoin(assessment, eq(assessment.applicationId, application.id))
    .leftJoin(policy, eq(policy.applicationId, application.id))
    .leftJoin(plan, eq(policy.planId, plan.id))
    .orderBy(desc(application.statusChangedAt), desc(assessment.createdAt));

  // First row per application is its newest assessment, given the ordering.
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

/** The intake snapshot — safe for either audience. */
export async function getApplication(applicationId: string) {
  const [row] = await db
    .select({
      application,
      person,
      owner: { id: appUser.id, fullName: appUser.fullName, email: appUser.email },
    })
    .from(application)
    .innerJoin(person, eq(application.personId, person.id))
    .innerJoin(appUser, eq(person.ownerUserId, appUser.id))
    .where(eq(application.id, applicationId))
    .limit(1);
  return row ?? null;
}

/** What the applicant told us. Their own words — shown to both audiences. */
export async function getDeclared(applicationId: string) {
  const [conditions, needs, priorities, providers, history] = await Promise.all([
    db.select().from(applicationCondition).where(eq(applicationCondition.applicationId, applicationId)),
    db.select().from(applicationNeed).where(eq(applicationNeed.applicationId, applicationId)),
    db.select().from(applicationPriority).where(eq(applicationPriority.applicationId, applicationId)),
    db.select().from(applicationExpectedProvider).where(eq(applicationExpectedProvider.applicationId, applicationId)),
    db
      .select()
      .from(applicationStatusHistory)
      .where(eq(applicationStatusHistory.applicationId, applicationId))
      .orderBy(asc(applicationStatusHistory.changedAt)),
  ]);
  return { conditions, needs, priorities, providers, history };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/**
 * Every intake conversation this user has started, most recent first, with a
 * one-line preview of the last message. Drives the chat history list, so
 * "start a new chat" and "pick up an old one" are both real choices instead
 * of the app silently deciding for the applicant.
 */
export async function listIntakeConversations(userId: string) {
  const conversations = await db
    .select({
      id: conversation.id,
      status: conversation.status,
      startedAt: conversation.startedAt,
      applicationId: conversation.applicationId,
      personName: person.fullName,
      relationship: person.relationshipToOwner,
      reference: application.reference,
    })
    .from(conversation)
    .leftJoin(application, eq(conversation.applicationId, application.id))
    .leftJoin(person, eq(application.personId, person.id))
    .where(and(eq(conversation.userId, userId), eq(conversation.purpose, "intake")))
    .orderBy(desc(conversation.startedAt));

  if (conversations.length === 0) return [];

  const messages = await db
    .select({ conversationId: message.conversationId, bodyText: message.bodyText })
    .from(message)
    .where(inArray(message.conversationId, conversations.map((c) => c.id)))
    .orderBy(desc(message.seq));

  // First hit per conversation is the latest, since `messages` is seq-desc.
  const previewByConversation = new Map<string, string>();
  for (const m of messages) {
    if (m.bodyText && !previewByConversation.has(m.conversationId)) {
      previewByConversation.set(m.conversationId, m.bodyText);
    }
  }

  return conversations.map((c) => ({ ...c, preview: previewByConversation.get(c.id) ?? null }));
}

/** All three plans priced for this application, best-ranked first. */
export async function getQuotes(applicationId: string) {
  return db
    .select({
      id: quote.id,
      planId: quote.planId,
      annualPremium: quote.annualPremium,
      eligible: quote.eligible,
      rank: quote.rank,
      score: quote.score,
      plan,
    })
    .from(quote)
    .innerJoin(plan, eq(quote.planId, plan.id))
    .where(eq(quote.applicationId, applicationId))
    .orderBy(asc(quote.rank));
}

/** The live recommendation plus why the other two plans lost. */
export async function getRecommendation(applicationId: string) {
  const [row] = await db
    .select({ recommendation, plan })
    .from(recommendation)
    .innerJoin(plan, eq(recommendation.planId, plan.id))
    .where(eq(recommendation.applicationId, applicationId))
    .orderBy(desc(recommendation.version))
    .limit(1);
  if (!row) return null;

  const rejections = await db
    .select({ planId: recommendationRejection.planId, reason: recommendationRejection.reason, plan })
    .from(recommendationRejection)
    .innerJoin(plan, eq(recommendationRejection.planId, plan.id))
    .where(eq(recommendationRejection.recommendationId, row.recommendation.id));

  return { ...row, rejections };
}

/** BROKER ONLY. Cohort assignment and the flags that fired, with their reasons. */
export async function getAssessment(applicationId: string) {
  const [row] = await db
    .select()
    .from(assessment)
    .where(eq(assessment.applicationId, applicationId))
    .orderBy(desc(assessment.createdAt))
    .limit(1);
  if (!row) return null;
  const flags = await db.select().from(assessmentFlag).where(eq(assessmentFlag.assessmentId, row.id));
  return { ...row, flags };
}

/**
 * BROKER ONLY. The system's own account of the classification it made — how
 * sure it was, and why it thinks a person should look. The applicant sees the
 * outcome of this, never the reasoning about how certain we were.
 */
export async function getClassificationDecision(applicationId: string) {
  const [row] = await db
    .select()
    .from(aiDecision)
    .where(
      and(eq(aiDecision.subjectId, applicationId), eq(aiDecision.decisionType, "cohort_classification")),
    )
    .orderBy(desc(aiDecision.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * What an advisor has said TO the applicant about this application.
 *
 * Deliberately narrow: `action`, the member-register message and when it was
 * said. The broker note on the same decision row is not selected here at all,
 * so there is no way for this helper to leak one into an applicant-facing
 * view by accident — the same reason the cohort and flag helpers are separate
 * from the declared-record ones.
 */
export async function getMemberNotices(applicationId: string) {
  const rows = await db
    .select({
      action: reviewDecision.action,
      payload: reviewDecision.payload,
      decidedAt: reviewDecision.decidedAt,
    })
    .from(reviewDecision)
    .innerJoin(reviewTask, eq(reviewDecision.reviewTaskId, reviewTask.id))
    .where(eq(reviewTask.subjectId, applicationId))
    .orderBy(desc(reviewDecision.decidedAt));

  return rows.flatMap((row) => {
    const message = row.payload?.memberMessage;
    if (typeof message !== "string" || !message.trim()) return [];
    return [{ action: row.action, message, decidedAt: row.decidedAt }];
  });
}

/** The intake conversation behind an application, if it came from chat. */
export async function getConversationForApplication(applicationId: string) {
  const [row] = await db
    .select({ id: conversation.id, status: conversation.status })
    .from(conversation)
    .where(eq(conversation.applicationId, applicationId))
    .orderBy(desc(conversation.startedAt))
    .limit(1);
  return row ?? null;
}

/** How many questions are sitting open on that conversation, waiting on them. */
export async function countOpenQuestions(conversationId: string) {
  const rows = await db
    .select({ id: conversationQuestion.id })
    .from(conversationQuestion)
    .where(and(eq(conversationQuestion.conversationId, conversationId), eq(conversationQuestion.status, "asked")));
  return rows.length;
}

// ---------------------------------------------------------------------------
// Policies & servicing
// ---------------------------------------------------------------------------

export async function getPolicyForApplication(applicationId: string) {
  const [row] = await db
    .select({ policy, plan, ledger: benefitLedger })
    .from(policy)
    .innerJoin(plan, eq(policy.planId, plan.id))
    .leftJoin(benefitLedger, eq(benefitLedger.policyId, policy.id))
    .where(eq(policy.applicationId, applicationId))
    .limit(1);
  return row ?? null;
}

export async function listPoliciesForUser(userId: string) {
  return db
    .select({ policy, plan, ledger: benefitLedger, personName: person.fullName })
    .from(policy)
    .innerJoin(person, eq(policy.personId, person.id))
    .innerJoin(plan, eq(policy.planId, plan.id))
    .leftJoin(benefitLedger, eq(benefitLedger.policyId, policy.id))
    .where(eq(person.ownerUserId, userId))
    .orderBy(desc(policy.createdAt));
}

export async function listAllPolicies() {
  return db
    .select({ policy, plan, ledger: benefitLedger, personName: person.fullName, ownerName: appUser.fullName })
    .from(policy)
    .innerJoin(person, eq(policy.personId, person.id))
    .innerJoin(appUser, eq(person.ownerUserId, appUser.id))
    .innerJoin(plan, eq(policy.planId, plan.id))
    .leftJoin(benefitLedger, eq(benefitLedger.policyId, policy.id))
    .orderBy(desc(policy.createdAt));
}

/**
 * The event log for a policy, oldest first. This is the authoritative history —
 * the ledger is only a projection of it, so anything that reasons about "what
 * happened" reads this, not the counters.
 */
export async function listEvents(policyId: string) {
  return db
    .select()
    .from(servicingEvent)
    .where(eq(servicingEvent.policyId, policyId))
    .orderBy(asc(servicingEvent.policyMonth), asc(servicingEvent.createdAt));
}

export async function listReassessments(policyId: string) {
  return db
    .select({ reassessment: planFitReassessment, plan })
    .from(planFitReassessment)
    .leftJoin(plan, eq(planFitReassessment.recommendedPlanId, plan.id))
    .where(eq(planFitReassessment.policyId, policyId))
    .orderBy(desc(planFitReassessment.createdAt));
}

// ---------------------------------------------------------------------------
// Review worklist — BROKER ONLY
// ---------------------------------------------------------------------------

/**
 * The queue, highest priority first.
 *
 * Ordering is a deliberate choice: open work only, then by priority score
 * descending, then oldest first so nothing starves at the bottom. Resolved
 * tasks are excluded outright — a worklist that lists finished work is a list,
 * not a queue.
 */
export async function listOpenReviewTasks() {
  return db
    .select({
      task: reviewTask,
      assignee: { id: appUser.id, fullName: appUser.fullName },
    })
    .from(reviewTask)
    .leftJoin(appUser, eq(reviewTask.assignedToUserId, appUser.id))
    .where(ne(reviewTask.status, "resolved"))
    .orderBy(desc(reviewTask.priorityScore), asc(reviewTask.createdAt));
}

/**
 * The queue with enough on each row to decide without opening the record.
 *
 * A worklist of reasons alone tells a broker that seven things are waiting and
 * nothing about which of them is hard. Each row carries who it is about, the
 * cohort, how sure the system was, the worst severity that fired and the line
 * saying why a person is needed — which is what lets the page group them by
 * the KIND of attention they want rather than listing them all as equal.
 */
export async function listQueue() {
  const tasks = await db
    .select({ task: reviewTask, assignee: { id: appUser.id, fullName: appUser.fullName } })
    .from(reviewTask)
    .leftJoin(appUser, eq(reviewTask.assignedToUserId, appUser.id))
    .where(ne(reviewTask.status, "resolved"))
    .orderBy(desc(reviewTask.priorityScore), asc(reviewTask.createdAt));
  if (tasks.length === 0) return [];

  const applicationIds = tasks
    .filter(({ task }) => task.subjectType === "application")
    .map(({ task }) => task.subjectId);

  if (applicationIds.length === 0) {
    return tasks.map((row) => ({ ...row, subject: null }));
  }

  const [applications, assessments, decisions] = await Promise.all([
    db
      .select({
        id: application.id,
        reference: application.reference,
        status: application.status,
        age: application.age,
        budget: application.budget,
        personName: person.fullName,
      })
      .from(application)
      .innerJoin(person, eq(application.personId, person.id))
      .where(inArray(application.id, applicationIds)),
    db
      .select()
      .from(assessment)
      .where(inArray(assessment.applicationId, applicationIds))
      .orderBy(desc(assessment.createdAt)),
    db
      .select()
      .from(aiDecision)
      .where(
        and(
          inArray(aiDecision.subjectId, applicationIds),
          eq(aiDecision.decisionType, "cohort_classification"),
        ),
      )
      .orderBy(desc(aiDecision.createdAt)),
  ]);

  // Newest first above, so the first hit per application is the live one.
  const latestAssessment = new Map<string, (typeof assessments)[number]>();
  for (const row of assessments) if (!latestAssessment.has(row.applicationId)) latestAssessment.set(row.applicationId, row);

  const latestDecision = new Map<string, (typeof decisions)[number]>();
  for (const row of decisions) if (!latestDecision.has(row.subjectId)) latestDecision.set(row.subjectId, row);

  const flags = latestAssessment.size
    ? await db
        .select()
        .from(assessmentFlag)
        .where(inArray(assessmentFlag.assessmentId, [...latestAssessment.values()].map((a) => a.id)))
    : [];

  const byApplication = new Map(applications.map((row) => [row.id, row]));

  return tasks.map((row) => {
    if (row.task.subjectType !== "application") return { ...row, subject: null };
    const app = byApplication.get(row.task.subjectId);
    const assessed = latestAssessment.get(row.task.subjectId);
    const own = assessed ? flags.filter((f) => f.assessmentId === assessed.id) : [];

    return {
      ...row,
      subject: app
        ? {
            reference: app.reference,
            personName: app.personName,
            age: app.age,
            budget: app.budget,
            status: app.status,
            cohort: assessed?.cohort ?? null,
            confidence: assessed?.confidence ?? null,
            uncertaintyReason: latestDecision.get(row.task.subjectId)?.uncertaintyReason ?? null,
            blocked: own.some((f) => f.severity === "block"),
            needsDecision: own.some((f) => f.severity === "review"),
            flagCount: own.length,
          }
        : null,
    };
  });
}

export async function listRecentlyResolvedTasks(limit = 10) {
  return db
    .select({ task: reviewTask, assignee: { id: appUser.id, fullName: appUser.fullName } })
    .from(reviewTask)
    .leftJoin(appUser, eq(reviewTask.assignedToUserId, appUser.id))
    .where(eq(reviewTask.status, "resolved"))
    .orderBy(desc(reviewTask.resolvedAt))
    .limit(limit);
}

/** Review tasks attached to one application, however they were routed. */
export async function getReviewTasksForApplication(applicationId: string, recommendationId?: string) {
  const subjectIds = [applicationId, ...(recommendationId ? [recommendationId] : [])];
  const tasks = await db
    .select()
    .from(reviewTask)
    .where(inArray(reviewTask.subjectId, subjectIds))
    .orderBy(desc(reviewTask.priorityScore));
  if (tasks.length === 0) return [];

  const decisions = await db
    .select({ decision: reviewDecision, actor: { fullName: appUser.fullName } })
    .from(reviewDecision)
    .innerJoin(appUser, eq(reviewDecision.actorUserId, appUser.id))
    .where(inArray(reviewDecision.reviewTaskId, tasks.map((t) => t.id)))
    .orderBy(asc(reviewDecision.decidedAt));

  return tasks.map((task) => ({
    task,
    decisions: decisions.filter((d) => d.decision.reviewTaskId === task.id),
  }));
}
