// Read layer. Everything the UI renders comes from here, so the two audiences
// stay honest: the applicant-facing helpers never select a broker-only column
// (cohort, flags, reviewer decisions, confidence), and the broker helpers
// return the whole record.

import { asc, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db/client";
import {
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

/** Every application, for the advisor's pipeline board. */
export async function listAllApplications() {
  return db
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
      planName: plan.name,
      policyId: policy.id,
    })
    .from(application)
    .innerJoin(person, eq(application.personId, person.id))
    .innerJoin(appUser, eq(person.ownerUserId, appUser.id))
    .leftJoin(assessment, eq(assessment.applicationId, application.id))
    .leftJoin(policy, eq(policy.applicationId, application.id))
    .leftJoin(plan, eq(policy.planId, plan.id))
    .orderBy(desc(application.statusChangedAt));
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
