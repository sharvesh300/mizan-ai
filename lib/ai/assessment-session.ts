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
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  aiDecision,
  application,
  applicationStatusHistory,
  assessment,
  assessmentFlag,
  modelRun,
  networkAdmits,
  plan,
  reviewTask,
  type ApplicationStatus,
  type ConfidenceLevel,
} from "@/db/schema";
import { runAssessment } from "@/lib/ai/graph";
import type { AssessmentOutcome } from "@/lib/ai/graph/state";
import { ASSESSMENT_PROMPT_VERSION } from "@/lib/ai/graph/nodes/assessment";
import { MODEL_ID, PROVIDER } from "@/lib/ai/openrouter";
import { admitsKey, type AssessmentContext, type AssessmentRecord, type Catalogue } from "@/lib/assessment";
import { loadAssessmentRecord } from "@/lib/assessment/load";

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
 * Everything the rules need for one application: the record (see
 * `loadAssessmentRecord`, lib/assessment/load.ts — shared with the read layer)
 * and the plan catalogue beside it.
 */
export async function loadAssessmentInputs(applicationId: string): Promise<{
  record: AssessmentRecord;
  catalogue: Catalogue;
  context: AssessmentContext;
} | null> {
  const [loaded, catalogue] = await Promise.all([loadAssessmentRecord(applicationId), loadCatalogue()]);
  if (!loaded) return null;
  return { ...loaded, catalogue };
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
 *
 * A clean `auto` gate means the record needs no one's decision before quoting
 * can start, so recommendation is SCHEDULED right here — not run inline. The
 * agent's tool-call loop can take several model round-trips, and the
 * applicant waiting on this response should not wait on that too; `after()`
 * runs it once the response has gone out (see `scheduleRecommendation` in
 * lib/ai/recommendation-session.ts, which also posts the chat follow-up once
 * it resolves). A gated record does NOT schedule it; recommendation starts
 * later, from `approveAssessment`/`editAssessment`
 * (app/applications/[id]/actions.ts), once a person has cleared the gate this
 * function opened. The import is dynamic to avoid a module cycle —
 * lib/ai/recommendation-session.ts imports `loadAssessmentInputs` from this
 * file.
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

  if (outcome.gate === "auto") {
    const { scheduleRecommendation } = await import("@/lib/ai/recommendation-session");
    scheduleRecommendation(applicationId);
  }

  return outcome;
}
