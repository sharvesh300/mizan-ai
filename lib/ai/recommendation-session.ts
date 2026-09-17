// Recommending a plan for an application whose record is clean, and writing
// the result down.
//
// Same division as assessment: the graph decides, this module loads what it
// needs and persists what came back. Keeping them apart is what lets the
// whole pricing/scoring engine run against the supplied fixtures with no
// database at all (db/seed/check-recommendation.ts), and what keeps the graph
// free of drizzle.
//
// THE INVARIANT (doc §2.1): an application is only recommended once its
// record is clean. `persistRecommendation` refuses any application whose
// status is `in_review`, or which has an open `review_task` with
// `subjectType: "application"` — a recommendation built on a record an
// advisor is still arguing with is worse than no recommendation, because it
// looks finished.
//
// WHAT GETS WRITTEN, and why each row exists:
//
//   model_run                 the mechanical call — only when a model was
//                             actually used, which is never for the pure
//                             deterministic fallback
//   quote                     one row per plan, frozen at quote time
//   recommendation            the live pick, broker-only confidence
//   recommendation_rejection  why the others lost, broker register
//   ai_decision               the semantic claim, `decisionType: "plan_recommendation"`
//   review_task               ONLY when confidence was low, verify failed, or
//                             the deterministic fallback ran — an
//                             INFORMATIONAL quality check that runs in
//                             PARALLEL with the applicant seeing the cards
//                             (they are never held back for this), and
//                             carries no approve/edit/override verb of its
//                             own. Distinct from Review 2 (`pickPlan`,
//                             app/applications/new/actions.ts), which opens
//                             once the applicant has actually chosen and is
//                             the only thing that gates policy issuance.
//   status history            assessed -> recommended, with the reason
//
// All of it in one transaction.

import "server-only";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { db } from "@/db/client";
import {
  aiDecision,
  application,
  applicationStatusHistory,
  assessment,
  assessmentFlag,
  conversationAction,
  modelRun,
  quote,
  recommendation,
  recommendationRejection,
  reviewTask,
  type ApplicationStatus,
  type ConfidenceLevel,
} from "@/db/schema";
import { loadAssessmentInputs } from "@/lib/ai/assessment-session";
import { announceClarificationRequest, announceRecommendationOutcome, latestConversationForApplication } from "@/lib/ai/conversation-continuation";
import { runRecommendation as runRecommendationGraph } from "@/lib/ai/graph";
import type { ClarificationAnswer } from "@/lib/ai/graph/state";
import type { RecommendationOutcome } from "@/lib/ai/graph/state";
import { RECOMMENDATION_PROMPT_VERSION } from "@/lib/ai/graph/nodes/recommendation";
import { CLARIFY_PROMPT_VERSION } from "@/lib/ai/graph/nodes/clarify";
import { MODEL_ID, PROVIDER } from "@/lib/ai/openrouter";
import type { PreviousRound } from "@/lib/ai/tools/plans";
import type { AssessmentRecord, Catalogue, CohortAssignment, Verdict } from "@/lib/assessment";
import type { CriterionId } from "@/lib/recommendation";

/** Same numbers `assessment-session.ts` uses, and for the same reason: the schema's `low_confidence_needs_review` CHECK. */
const CONFIDENCE_VALUE: Record<ConfidenceLevel, number> = { high: 0.95, medium: 0.8, low: 0.45 };

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Rebuild what the graph needs, from the rows assessment already wrote.
 *
 * `cohort`/`verdict` are the assessment's own — recommendation does not
 * re-derive them, it reads the row an advisor may have already corrected.
 * Returns null when the application has never been assessed at all, which is
 * the one precondition weaker than the `in_review` guard: there is nothing
 * to recommend from yet.
 */
export async function loadRecommendationInputs(applicationId: string): Promise<{
  record: AssessmentRecord;
  catalogue: Catalogue;
  cohort: CohortAssignment;
  verdict: Verdict;
  previousRounds: PreviousRound[];
  clarificationAsked: boolean;
  clarification: ClarificationAnswer | null;
  /** Where a clarifying question would be posted, if one is asked this round. */
  conversationId: string | null;
} | null> {
  const inputs = await loadAssessmentInputs(applicationId);
  if (!inputs) return null;

  const [latestAssessment] = await db
    .select()
    .from(assessment)
    .where(eq(assessment.applicationId, applicationId))
    .orderBy(desc(assessment.createdAt))
    .limit(1);
  if (!latestAssessment) return null;

  const flagRows = await db.select().from(assessmentFlag).where(eq(assessmentFlag.assessmentId, latestAssessment.id));
  // `layer` is not persisted on assessment_flag — it only ever separated how
  // narrate.ts grouped rules, which recommendation has no use for.
  const flags = flagRows.map((f) => ({ ruleCode: f.ruleCode, severity: f.severity, fields: f.fields, reason: f.reason, layer: "constraint" as const }));

  const rejectionActions = await db
    .select()
    .from(conversationAction)
    .where(and(eq(conversationAction.subjectType, "application"), eq(conversationAction.subjectId, applicationId), eq(conversationAction.actionType, "reject_shortlist")))
    .orderBy(asc(conversationAction.createdAt));

  const previousRounds: PreviousRound[] = rejectionActions.map((row, i) => {
    const args = row.arguments as { planIds?: string[]; reason?: string } | null;
    return { round: i + 1, rejectedPlanIds: args?.planIds ?? [], reason: args?.reason ?? "" };
  });

  // Reconstructed purely from row existence/content, every call — this is the
  // ONLY durable record of whether a clarifying question was ever asked and
  // what the applicant said back. Nothing about it lives in LangGraph's
  // checkpointer, which is fresh and discarded per invocation (see the
  // comment on `runRecommendation`, lib/ai/graph.ts). Same pattern as
  // `previousRounds` above, off a different `conversation_action` kind.
  const convo = await latestConversationForApplication(applicationId);

  const [askedAction] = await db
    .select()
    .from(conversationAction)
    .where(and(eq(conversationAction.subjectType, "application"), eq(conversationAction.subjectId, applicationId), eq(conversationAction.actionType, "recommendation_clarify_asked")))
    .limit(1);
  // With no conversation, there is nowhere to post a clarifying question at
  // all (e.g. a form-only application, never a chat) — force `true` so
  // `routeAfterVerify` (lib/ai/graph/nodes/clarify.ts) never sends this
  // application down a path with no way to actually ask.
  const clarificationAsked = Boolean(askedAction) || !convo;

  let clarification: ClarificationAnswer | null = null;
  if (askedAction) {
    const [answeredAction] = await db
      .select()
      .from(conversationAction)
      .where(and(eq(conversationAction.subjectType, "application"), eq(conversationAction.subjectId, applicationId), eq(conversationAction.actionType, "recommendation_clarify_answered")))
      .limit(1);
    if (answeredAction) {
      const askedArgs = askedAction.arguments as { target?: string; question?: string } | null;
      const answeredArgs = answeredAction.arguments as { rawAnswer?: string } | null;
      if (askedArgs?.target && askedArgs.question && answeredArgs?.rawAnswer) {
        clarification = { target: askedArgs.target as CriterionId, question: askedArgs.question, rawAnswer: answeredArgs.rawAnswer };
      }
    }
  }

  return {
    record: inputs.record,
    catalogue: inputs.catalogue,
    cohort: { cohort: latestAssessment.cohort, rationale: "" },
    verdict: {
      flags,
      confidence: latestAssessment.confidence,
      uncertaintyReason: null,
      gate: "auto",
      priorityScore: 0,
      queueReason: "",
    },
    previousRounds,
    clarificationAsked,
    clarification,
    conversationId: convo?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export async function persistRecommendation(
  applicationId: string,
  outcome: RecommendationOutcome,
  round: number,
  conversationId: string | null,
): Promise<{ recommendationId: string | null; reviewTaskId: string | null }> {
  const now = new Date();

  const [app] = await db.select({ status: application.status }).from(application).where(eq(application.id, applicationId)).limit(1);
  if (!app) throw new Error("Application not found.");

  // THE INVARIANT: never build a recommendation on a record an advisor is
  // still arguing with.
  if (app.status === "in_review") {
    throw new Error("Cannot recommend while the application record is in review.");
  }
  const [openAppReview] = await db
    .select({ id: reviewTask.id })
    .from(reviewTask)
    .where(and(eq(reviewTask.subjectType, "application"), eq(reviewTask.subjectId, applicationId), ne(reviewTask.status, "resolved")))
    .limit(1);
  if (openAppReview) {
    throw new Error("Cannot recommend while the application has an open review task.");
  }

  // A clarifying question, not a shortlist — nothing is presentable yet.
  // Quotes still get written (price() is deterministic and ran regardless);
  // no recommendation, review_task, or status change. The `_asked` insert is
  // the race-safety boundary (db/schema/actions.ts's
  // one_clarify_asked_per_application partial unique index): if another
  // worker already asked for this application, `.onConflictDoNothing()`
  // returns nothing and this whole attempt is discarded rather than writing
  // a second, redundant audit trail.
  if (outcome.pendingClarification) {
    const clarification = outcome.pendingClarification;
    await db.run(sql`begin`);
    try {
      for (const q of outcome.quotes) {
        await db
          .insert(quote)
          .values({ applicationId, planId: q.planId, annualPremium: q.annualPremium, eligible: q.eligible, rank: q.rank, score: q.score })
          .onConflictDoUpdate({
            target: [quote.applicationId, quote.planId],
            set: { annualPremium: q.annualPremium, eligible: q.eligible, rank: q.rank, score: q.score },
          });
      }

      if (!conversationId) {
        // Structurally shouldn't happen — loadRecommendationInputs forces
        // clarificationAsked=true when there is no conversation to ask in,
        // so `routeAfterVerify` should never have reached `clarify` here.
        // Defensive only: there is nowhere to post the question, so this
        // attempt is discarded exactly like a lost race.
        await db.run(sql`commit`);
        return { recommendationId: null, reviewTaskId: null };
      }

      const [asked] = await db
        .insert(conversationAction)
        .values({
          conversationId,
          actionType: "recommendation_clarify_asked",
          arguments: { target: clarification.target, question: clarification.question },
          subjectType: "application",
          subjectId: applicationId,
          status: "succeeded",
          actorKind: "system",
          completedAt: now,
        })
        .onConflictDoNothing()
        .returning();

      if (!asked) {
        await db.run(sql`commit`);
        return { recommendationId: null, reviewTaskId: null };
      }

      // The mechanical call that produced the low-confidence shortlist this
      // clarification is about — same condition as the full path below:
      // never written for the pure deterministic fallback, since no model ran.
      let modelRunId: string | null = null;
      if (outcome.servedBy && !outcome.fellBackTo) {
        const [run] = await db
          .insert(modelRun)
          .values({
            purpose: "plan_recommendation",
            provider: PROVIDER,
            modelId: outcome.servedBy ?? MODEL_ID,
            promptVersion: RECOMMENDATION_PROMPT_VERSION,
            request: { applicationId, round },
            response: { trace: outcome.trace, verifyFailed: outcome.verifyFailed },
            latencyMs: outcome.latencyMs,
            status: "ok",
          })
          .returning();
        modelRunId = run.id;
      }

      // `clarification_required` — its own real status (db/schema/enums.ts),
      // not buried in `output`, so it is exactly as supersedable as `proposed`
      // once round 2 writes a real decision (see the widened query below).
      await db.insert(aiDecision).values({
        decisionType: "plan_recommendation",
        subjectType: "application",
        subjectId: applicationId,
        modelRunId,
        output: {
          confidence: outcome.confidence,
          uncertaintyReason: outcome.uncertaintyReason,
          clarification: { ...clarification, promptVersion: CLARIFY_PROMPT_VERSION },
          round,
        },
        summary: `clarification requested · round ${round} · ${clarification.target}`,
        confidence: CONFIDENCE_VALUE[outcome.confidence],
        uncertaintyReason: outcome.uncertaintyReason,
        // Required by the schema's own low_confidence_needs_review CHECK
        // (confidence < 0.75 must carry requiresReview) — does not imply a
        // review_task exists; reviewTaskId stays null, this needs the
        // applicant, not an advisor.
        requiresReview: true,
        status: "clarification_required",
        reviewTaskId: null,
        appliedToId: null,
      });

      await db.run(sql`commit`);
    } catch (error) {
      await db.run(sql`rollback`);
      throw error;
    }
    return { recommendationId: null, reviewTaskId: null };
  }

  const gated = outcome.routedToReview;
  const winner = outcome.shortlist[0];
  if (!winner) throw new Error("No plan was shortlisted.");

  const recommendationId = crypto.randomUUID();
  let reviewTaskId: string | null = null;

  await db.run(sql`begin`);
  try {
    // The mechanical call, when there was one. The pure deterministic
    // fallback never reaches the model, so it never gets a run row either —
    // same discipline persistAssessment holds for cohort classification.
    let modelRunId: string | null = null;
    if (outcome.servedBy && !outcome.fellBackTo) {
      const [run] = await db
        .insert(modelRun)
        .values({
          purpose: "plan_recommendation",
          provider: PROVIDER,
          modelId: outcome.servedBy ?? MODEL_ID,
          promptVersion: RECOMMENDATION_PROMPT_VERSION,
          // Never the record itself — a pointer plus the round is enough.
          request: { applicationId, round },
          response: { trace: outcome.trace, verifyFailed: outcome.verifyFailed },
          latencyMs: outcome.latencyMs,
          status: "ok",
        })
        .returning();
      modelRunId = run.id;
    }

    // Quotes — upsert on a re-run rather than duplicating.
    for (const q of outcome.quotes) {
      await db
        .insert(quote)
        .values({ applicationId, planId: q.planId, annualPremium: q.annualPremium, eligible: q.eligible, rank: q.rank, score: q.score })
        .onConflictDoUpdate({
          target: [quote.applicationId, quote.planId],
          set: { annualPremium: q.annualPremium, eligible: q.eligible, rank: q.rank, score: q.score },
        });
    }

    // Anything still live is superseded before the new one lands — required
    // by the `one_live_recommendation` partial unique index, and the same
    // "insert a new row, don't overwrite" idiom assessment uses.
    await db
      .update(recommendation)
      .set({ status: "superseded" })
      .where(and(eq(recommendation.applicationId, applicationId), sql`${recommendation.status} in ('pending_review','approved','edited','overridden')`));

    await db.insert(recommendation).values({
      id: recommendationId,
      applicationId,
      planId: winner.planId,
      version: round,
      status: "pending_review",
      brokerReasoning: outcome.brokerReasoning,
      memberReasoning: outcome.memberReasoning,
      confidence: CONFIDENCE_VALUE[outcome.confidence],
      uncertaintyReason: outcome.uncertaintyReason,
      createdBy: "system",
    });

    if (outcome.rejections.length > 0) {
      await db.insert(recommendationRejection).values(
        outcome.rejections.map((r) => ({ recommendationId, planId: r.planId, reason: r.reason })),
      );
    }

    // Anything the previous round proposed is no longer the live claim —
    // including a `clarification_required` decision this round's answer just
    // resolved (whether or not confidence actually improved; either way this
    // round is the current word on it).
    await db
      .update(aiDecision)
      .set({ status: "superseded" })
      .where(
        and(
          eq(aiDecision.subjectType, "application"),
          eq(aiDecision.subjectId, applicationId),
          eq(aiDecision.decisionType, "plan_recommendation"),
          inArray(aiDecision.status, ["proposed", "clarification_required"]),
        ),
      );

    // An informational quality check, not a gate — the applicant sees the
    // cards regardless (`announceRecommendationOutcome`,
    // lib/ai/conversation-continuation.ts). Distinct from Review 2, which
    // opens later, after the applicant picks (app/applications/new/actions.ts's
    // `pickPlan`), and is the only thing that gates policy issuance.
    if (gated) {
      const [task] = await db
        .insert(reviewTask)
        .values({
          subjectType: "recommendation",
          subjectId: recommendationId,
          reason: outcome.fellBackTo ?? outcome.uncertaintyReason ?? "Recommendation needs review before it reaches the applicant.",
          priorityScore: outcome.fellBackTo ? 80 : outcome.verifyFailed ? 85 : 70,
          status: "open",
        })
        .returning();
      reviewTaskId = task.id;
    }

    await db.insert(aiDecision).values({
      decisionType: "plan_recommendation",
      subjectType: "application",
      subjectId: applicationId,
      modelRunId,
      output: {
        recommendationId,
        picks: outcome.shortlist,
        rejections: outcome.rejections,
        confidence: outcome.confidence,
        uncertaintyReason: outcome.uncertaintyReason,
        fellBackTo: outcome.fellBackTo,
        verifyFailed: outcome.verifyFailed,
        round,
      },
      summary: `${winner.planId} · round ${round} · ${outcome.confidence}${outcome.fellBackTo ? " · fallback" : ""}`,
      confidence: CONFIDENCE_VALUE[outcome.confidence],
      uncertaintyReason: outcome.uncertaintyReason,
      requiresReview: gated,
      reviewTaskId,
      appliedToId: recommendationId,
      status: gated ? "proposed" : "auto_accepted",
    });

    // The journey always advances once a round completes — `gated` is the
    // signal that an advisor should look this one over too, not a reason to
    // leave the applicant staring at "assessed" with nothing to act on.
    // Review 2 (policy issuance) is still the thing that gates on a human
    // decision; presenting a shortlist is reversible, so it does not need to.
    const toStatus: ApplicationStatus = "recommended";
    if (app.status !== toStatus) {
      await db.update(application).set({ status: toStatus, statusChangedAt: now }).where(eq(application.id, applicationId));
      await db.insert(applicationStatusHistory).values({
        applicationId,
        fromStatus: app.status,
        toStatus,
        changedBy: "system",
        reason: gated
          ? `Recommended ${winner.planId} (round ${round}) — confidence ${outcome.confidence}, flagged for advisor review alongside the applicant's copy`
          : `Recommended ${winner.planId} (round ${round}) — confidence ${outcome.confidence}`,
      });
    }

    await db.run(sql`commit`);
  } catch (error) {
    await db.run(sql`rollback`);
    throw error;
  }

  return { recommendationId, reviewTaskId };
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Recommend a plan for one application: build the shortlist and write it down.
 *
 * Called the moment an application's record is clean — either straight off
 * `validateAndClassify` when the gate was `auto`, or right after an advisor
 * clears Review 1. Recommending twice would write a second live row for the
 * same application, so a re-run is explicit (`force`), the same idempotency
 * shape `validateAndClassify` uses.
 */
export async function runRecommendation(
  applicationId: string,
  options: { force?: boolean } = {},
): Promise<RecommendationOutcome | null> {
  const [existing] = await db
    .select({ id: recommendation.id })
    .from(recommendation)
    .where(and(eq(recommendation.applicationId, applicationId), sql`${recommendation.status} in ('pending_review','approved','edited','overridden')`))
    .limit(1);
  if (existing && !options.force) return null;

  const inputs = await loadRecommendationInputs(applicationId);
  if (!inputs) return null;

  const [row] = await db.select({ version: recommendation.version }).from(recommendation).where(eq(recommendation.applicationId, applicationId)).orderBy(desc(recommendation.version)).limit(1);
  const round = (row?.version ?? 0) + 1;

  const outcome = await runRecommendationGraph(inputs);
  await persistRecommendation(applicationId, outcome, round, inputs.conversationId);
  return outcome;
}

// ---------------------------------------------------------------------------
// Background scheduling
// ---------------------------------------------------------------------------

/**
 * Schedule `runRecommendation` to run AFTER the current request has already
 * responded (Next's `after()`), instead of making the applicant's submit or
 * the advisor's approve wait on however long the tool-call loop takes.
 *
 * Pricing is fast, pure arithmetic — it is the agent's tool-call loop
 * (`lib/ai/graph/nodes/recommend.ts`) that can run to 8 model round-trips.
 * Blocking a request on that is the wrong tradeoff: the record is already
 * clean, so nothing is lost by finishing the write a few seconds after the
 * response, and everything downstream (the chat message, the queue row) is
 * driven off the database, not off this call returning.
 *
 * Call sites never await this — that is the point. `runRecommendation`'s own
 * idempotency guard (`existing && !options.force`) still applies, so two
 * schedules racing for the same application do not double-write.
 */
export function scheduleRecommendation(applicationId: string, options: { force?: boolean } = {}): void {
  after(async () => {
    let outcome: RecommendationOutcome | null = null;
    try {
      outcome = await runRecommendation(applicationId, options);
    } catch (error) {
      console.error("[recommendation] background run failed", applicationId, error);
      return;
    }
    let conversationId: string | null = null;
    try {
      // A clarifying question, not a shortlist — a different message, and
      // nothing to reveal yet (announceClarificationRequest,
      // lib/ai/conversation-continuation.ts).
      conversationId = outcome?.pendingClarification
        ? await announceClarificationRequest(applicationId, outcome.pendingClarification.question)
        : await announceRecommendationOutcome(applicationId);
    } catch (error) {
      console.error("[recommendation] announcing the outcome failed", applicationId, error);
    }
    try {
      revalidatePath(`/applications/${applicationId}`);
      revalidatePath("/applications");
      revalidatePath("/queue");
      // The applicant is sitting on this exact page, polling for the card
      // (components/chat-refresh.tsx) — revalidate it directly rather than
      // waiting for the poller's own navigation to pick up a stale cache.
      if (conversationId) revalidatePath(`/applications/new/chat/${conversationId}`);
    } catch {
      // Cache revalidation is best-effort here — a stale page until the next
      // navigation is not worth failing the background job over.
    }
  });
}
