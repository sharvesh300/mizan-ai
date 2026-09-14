// Assessing an application that exists, and writing the result down.
//
// Same division as intake: the graph decides, this module loads what it needs
// and persists what came back. Keeping them apart is what lets the whole rule
// engine run against the supplied fixtures with no database at all
// (db/seed/check-assessment.ts), and what keeps the graph free of drizzle.
//
// WHAT GETS WRITTEN, and why each row exists:
//
//   model_run         the mechanical call — only when a model was actually
//                     used, which is never for a record with no flags
//   ai_decision       the semantic claim, with the confidence and the reason
//                     it needs a human. This is the row the broker's "why am
//                     I looking at this" reads from.
//   assessment        the cohort, broker-only
//   assessment_flag   one row per rule that fired, in the broker register
//   review_task       the queue item, ONLY when the gate says a person owns it
//   status history    submitted -> assessed | in_review, with the reason
//
// All of it in one transaction. A cohort with no flags, or flags with no
// queue item, is a record that lies about itself.

import "server-only";
import { and, eq, ne, notInArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  aiDecision,
  application,
  applicationCondition,
  applicationExpectedProvider,
  applicationNeed,
  applicationPriority,
  applicationStatusHistory,
  assessment,
  assessmentFlag,
  modelRun,
  networkAdmits,
  person,
  plan,
  reviewTask,
  type ApplicationStatus,
  type ConfidenceLevel,
} from "@/db/schema";
import { runAssessment } from "@/lib/ai/graph";
import type { AssessmentOutcome } from "@/lib/ai/graph/state";
import { ASSESSMENT_PROMPT_VERSION } from "@/lib/ai/graph/nodes/narrate";
import { MODEL_ID, PROVIDER } from "@/lib/ai/openrouter";
import { admitsKey, type AssessmentContext, type AssessmentRecord, type Catalogue } from "@/lib/assessment";

/** Statuses that mean an application is no longer in play. */
const TERMINAL: ApplicationStatus[] = ["withdrawn", "declined", "expired", "policy_issued"];

/**
 * `ai_decision.confidence` is a number and the assessment's is a band, so the
 * two have to be mapped. The numbers are chosen against the schema's own
 * `low_confidence_needs_review` CHECK — anything under 0.75 must carry
 * `requires_review` — so that a `medium` assessment which the gate cleared
 * (P3, P5: a warn that caps confidence but routes nothing) can still be
 * written as auto-accepted, while a `low` one cannot.
 */
const CONFIDENCE_VALUE: Record<ConfidenceLevel, number> = { high: 0.95, medium: 0.8, low: 0.45 };

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** The plan catalogue, in the shape the rules read. */
export async function loadCatalogue(): Promise<Catalogue> {
  const [plans, admits] = await Promise.all([db.select().from(plan), db.select().from(networkAdmits)]);
  return {
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      annualPremium: p.annualPremium,
      deductible: p.deductible,
      network: p.network,
      outpatientCopayPct: p.outpatientCopayPct,
      annualLimit: p.annualLimit,
      dentalOptical: p.dentalOptical,
      maternityCovered: p.maternityCovered,
      maternityWaitingPeriodMonths: p.maternityWaitingPeriodMonths,
      maternityLimit: p.maternityLimit,
      chronicCovered: p.chronicCovered,
      chronicWaitingPeriodMonths: p.chronicWaitingPeriodMonths,
    })),
    admits: new Set(admits.map((a) => admitsKey(a.network, a.providerTier))),
  };
}

/**
 * Rebuild the record the rules read, from the rows intake wrote.
 *
 * Nothing is re-derived and nothing is asked for again — this is the same
 * declared data both views render, read once more for a different purpose.
 */
export async function loadAssessmentInputs(applicationId: string): Promise<{
  record: AssessmentRecord;
  catalogue: Catalogue;
  context: AssessmentContext;
} | null> {
  const [row] = await db
    .select({ application, person })
    .from(application)
    .innerJoin(person, eq(application.personId, person.id))
    .where(eq(application.id, applicationId))
    .limit(1);
  if (!row) return null;

  const [conditions, needs, priorities, providers, catalogue, siblings] = await Promise.all([
    db.select().from(applicationCondition).where(eq(applicationCondition.applicationId, applicationId)),
    db.select().from(applicationNeed).where(eq(applicationNeed.applicationId, applicationId)),
    db.select().from(applicationPriority).where(eq(applicationPriority.applicationId, applicationId)),
    db.select().from(applicationExpectedProvider).where(eq(applicationExpectedProvider.applicationId, applicationId)),
    loadCatalogue(),
    db
      .select({ id: application.id })
      .from(application)
      .where(and(eq(application.personId, row.person.id), notInArray(application.status, TERMINAL))),
  ]);

  const record: AssessmentRecord = {
    applicationId,
    reference: row.application.reference,
    age: row.application.age,
    maritalStatus: row.application.maritalStatus,
    smoker: row.application.smoker,
    emirate: row.application.emirate,
    budget: row.application.budget,
    policyInception: row.application.policyInception,
    treatmentOutsideUaeExpected: row.application.treatmentOutsideUaeExpected,
    subjectRelationship: row.person.relationshipToOwner,
    conditions: conditions.map((c) => ({
      id: c.id,
      rawText: c.rawText,
      conditionCode: c.conditionCode,
      stability: c.stability,
    })),
    needs: needs.map((n) => ({
      id: n.id,
      rawText: n.rawText,
      benefitClass: n.benefitClass,
      horizonMonths: n.horizonMonths,
    })),
    priorities: priorities.map((p) => ({ id: p.id, rawText: p.rawText, tag: p.tag })),
    providers: providers.map((p) => ({ id: p.id, providerName: p.providerName, tier: p.tier })),
  };

  return {
    record,
    catalogue,
    context: {
      // Explicit rather than read inside a rule, so replaying an assessment
      // produces the flags it produced on the day, not today's.
      today: new Date().toISOString().slice(0, 10),
      openApplicationsForPerson: siblings.filter((s) => s.id !== applicationId).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export async function persistAssessment(
  applicationId: string,
  outcome: AssessmentOutcome,
  previousStatus: ApplicationStatus,
): Promise<{ assessmentId: string; reviewTaskId: string | null }> {
  const gated = outcome.gate !== "auto";
  const toStatus: ApplicationStatus = gated ? "in_review" : "assessed";
  const now = new Date();

  const assessmentId = crypto.randomUUID();
  let reviewTaskId: string | null = null;

  await db.run(sql`begin`);
  try {
    // The mechanical call, when there was one. A record with nothing flagged
    // never reaches the model, and inventing a run row for it would put a
    // model's name on a decision it had no part in.
    let modelRunId: string | null = null;
    if (outcome.servedBy) {
      const [run] = await db
        .insert(modelRun)
        .values({
          purpose: "cohort_classification",
          provider: PROVIDER,
          modelId: outcome.servedBy ?? MODEL_ID,
          promptVersion: ASSESSMENT_PROMPT_VERSION,
          // Never the record itself — it is health information. A pointer is enough.
          request: { applicationId, flags: outcome.flags.map((f) => f.ruleCode) },
          response: { narrated: outcome.narrated, queueReason: outcome.queueReason },
          latencyMs: outcome.latencyMs,
          status: "ok",
        })
        .returning();
      modelRunId = run.id;
    }

    await db.insert(assessment).values({
      id: assessmentId,
      applicationId,
      cohort: outcome.cohort.cohort,
      confidence: outcome.confidence,
      createdBy: "system",
    });

    if (outcome.flags.length > 0) {
      await db.insert(assessmentFlag).values(
        outcome.flags.map((flag) => ({
          assessmentId,
          ruleCode: flag.ruleCode,
          severity: flag.severity,
          fields: flag.fields,
          reason: flag.reason,
        })),
      );
    }

    if (gated) {
      // A re-run refreshes the task it already has rather than opening a
      // second one. Two queue items for one application is the advisor
      // deciding the same thing twice, and the second decision has nothing
      // left to decide.
      const [existingTask] = await db
        .select({ id: reviewTask.id })
        .from(reviewTask)
        .where(
          and(
            eq(reviewTask.subjectType, "application"),
            eq(reviewTask.subjectId, applicationId),
            ne(reviewTask.status, "resolved"),
          ),
        )
        .limit(1);

      if (existingTask) {
        await db
          .update(reviewTask)
          .set({ reason: outcome.queueReason, priorityScore: outcome.priorityScore })
          .where(eq(reviewTask.id, existingTask.id));
        reviewTaskId = existingTask.id;
      } else {
        const [task] = await db
          .insert(reviewTask)
          .values({
            subjectType: "application",
            subjectId: applicationId,
            reason: outcome.queueReason,
            priorityScore: outcome.priorityScore,
            status: "open",
          })
          .returning();
        reviewTaskId = task.id;
      }
    }

    if (!gated) {
      // The record used to need a person and no longer does — the applicant
      // answered, or the declared data changed. The task is withdrawn rather
      // than decided: no `review_decision` is written, because nobody decided
      // anything. Leaving it open would put work in the queue that has
      // nothing left to do.
      await db
        .update(reviewTask)
        .set({ status: "resolved", resolvedAt: now })
        .where(
          and(
            eq(reviewTask.subjectType, "application"),
            eq(reviewTask.subjectId, applicationId),
            ne(reviewTask.status, "resolved"),
          ),
        );
    }

    // Anything the previous pass proposed is no longer the live claim.
    await db
      .update(aiDecision)
      .set({ status: "superseded" })
      .where(
        and(
          eq(aiDecision.subjectId, applicationId),
          eq(aiDecision.decisionType, "cohort_classification"),
          eq(aiDecision.status, "proposed"),
        ),
      );

    // The semantic claim, and the row the queue reads "why this needs you"
    // from. `applied_to_id` points at the assessment it produced, so an
    // advisor editing the cohort can see what the system originally said.
    await db.insert(aiDecision).values({
      decisionType: "cohort_classification",
      subjectType: "application",
      subjectId: applicationId,
      modelRunId,
      output: {
        cohort: outcome.cohort.cohort,
        rationale: outcome.cohort.rationale,
        gate: outcome.gate,
        flags: outcome.flags,
      },
      summary: `${outcome.cohort.cohort} · ${outcome.flags.length} flag(s) · ${outcome.gate}`,
      confidence: CONFIDENCE_VALUE[outcome.confidence],
      uncertaintyReason: outcome.uncertaintyReason,
      requiresReview: gated,
      reviewTaskId,
      appliedToId: assessmentId,
      // Cohort and flags are deterministic, so they are applied on the spot.
      // What `requires_review` gates is the APPLICATION, not the claim: the
      // rules are certain, and what they found is what a person must decide.
      status: gated ? "proposed" : "auto_accepted",
    });

    await db
      .update(application)
      .set({ status: toStatus, statusChangedAt: now })
      .where(eq(application.id, applicationId));

    await db.insert(applicationStatusHistory).values({
      applicationId,
      fromStatus: previousStatus,
      toStatus,
      changedBy: "system",
      reason: gated
        ? `Routed for review — ${outcome.queueReason}`
        : `Assessed as ${outcome.cohort.cohort}; nothing requiring a decision`,
    });

    await db.run(sql`commit`);
  } catch (error) {
    await db.run(sql`rollback`);
    throw error;
  }

  return { assessmentId, reviewTaskId };
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Validate, classify and route one application.
 *
 * Called the moment an application exists — the applicant is waiting on the
 * other side of it, which is the whole point: "processed immediately" instead
 * of a callback in two hours.
 *
 * Assessing twice would write a second cohort and a second queue item for the
 * same record, so a re-run is explicit (`force`) and belongs to the advisor's
 * re-classify action, not to an accidental double submit.
 */
export async function validateAndClassify(
  applicationId: string,
  options: { force?: boolean } = {},
): Promise<AssessmentOutcome | null> {
  const [existing] = await db
    .select({ id: assessment.id })
    .from(assessment)
    .where(eq(assessment.applicationId, applicationId))
    .limit(1);
  if (existing && !options.force) return null;

  const inputs = await loadAssessmentInputs(applicationId);
  if (!inputs) return null;

  const [row] = await db
    .select({ status: application.status })
    .from(application)
    .where(eq(application.id, applicationId))
    .limit(1);

  const outcome = await runAssessment(inputs);
  await persistAssessment(applicationId, outcome, row?.status ?? "submitted");
  return outcome;
}
