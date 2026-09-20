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
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { db } from "@/db/client";
import {
  aiDecision,
  application,
  applicationPreferenceSignal,
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
import {
  announceClarificationRequest,
  announceNegotiationReply,
  announceRecommendationOutcome,
  announceTradeOff,
  latestConversationForApplication,
} from "@/lib/ai/conversation-continuation";
import { runRecommendation as runRecommendationGraph } from "@/lib/ai/graph";
import type { ClarificationAnswer, NegotiationResult, PendingTradeOff, RecommendationOutcome } from "@/lib/ai/graph/state";
import { RECOMMENDATION_PROMPT_VERSION } from "@/lib/ai/graph/nodes/recommendation";
import { CLARIFY_PROMPT_VERSION } from "@/lib/ai/graph/nodes/clarify";
import { NEGOTIATE_PROMPT_VERSION } from "@/lib/ai/graph/nodes/negotiate";
import { SIGNALS_PROMPT_VERSION } from "@/lib/ai/graph/nodes/signals";
import { TRADEOFF_PROMPT_VERSION } from "@/lib/ai/graph/nodes/tradeoff";
import { MODEL_ID, PROVIDER } from "@/lib/ai/openrouter";
import type { PreviousRound } from "@/lib/ai/tools/plans";
import type { AssessmentRecord, Catalogue, CohortAssignment, Verdict } from "@/lib/assessment";
import { readTradeOffAnswer, signalsForChoice, type CriterionId, type PreferenceSignal, type TradeOff, type TradeOffChoice } from "@/lib/recommendation";

/** Same numbers `assessment-session.ts` uses, and for the same reason: the schema's `low_confidence_needs_review` CHECK. */
const CONFIDENCE_VALUE: Record<ConfidenceLevel, number> = { high: 0.95, medium: 0.8, low: 0.45 };

/**
 * After this many rounds, a signal's confidence is halved AT LOAD TIME — the
 * stored row is never rewritten, because what the applicant said in round 1 is
 * a fact and it stays one. What decays is how much we let it drive a weight
 * three rounds later, after they have rejected two shortlists built on it.
 */
const SIGNAL_DECAY_ROUNDS = 3;
const SIGNAL_DECAY_FACTOR = 0.5;

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
  /** Live signals only (`superseded_at is null`), with decay already applied. */
  preferenceSignals: PreferenceSignal[];
  /** 1-based, the round about to be built or negotiated. */
  round: number;
  /** How many times the agent has already defended a shortlist to this applicant. */
  negotiationTurns: number;
  /** Whether the one trade-off question has ever been asked — from the row's existence alone. */
  tradeOffAsked: boolean;
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

  // The round about to be built. Derived from the rejection rows rather than
  // from `recommendation.version`, because a `convince` turn writes no
  // recommendation row but is still an answer to a rejection — counting
  // versions would let an applicant negotiate forever.
  const round = previousRounds.length + 1;

  // Same discipline: the negotiation budget is a COUNT OF ROWS, so a retried
  // background job, a restarted process, or two workers racing cannot reset
  // it. Nothing about it lives in the checkpointer.
  const negotiationActions = await db
    .select({ id: conversationAction.id })
    .from(conversationAction)
    .where(
      and(
        eq(conversationAction.subjectType, "application"),
        eq(conversationAction.subjectId, applicationId),
        eq(conversationAction.actionType, "recommendation_negotiated"),
      ),
    );

  const [tradeOffAction] = await db
    .select({ id: conversationAction.id })
    .from(conversationAction)
    .where(
      and(
        eq(conversationAction.subjectType, "application"),
        eq(conversationAction.subjectId, applicationId),
        eq(conversationAction.actionType, "recommendation_tradeoff_asked"),
      ),
    )
    .limit(1);

  const signalRows = await db
    .select()
    .from(applicationPreferenceSignal)
    .where(and(eq(applicationPreferenceSignal.applicationId, applicationId), isNull(applicationPreferenceSignal.supersededAt)))
    .orderBy(asc(applicationPreferenceSignal.createdAt));

  const preferenceSignals: PreferenceSignal[] = signalRows.map((row) => ({
    dimension: row.dimension as CriterionId,
    direction: row.direction,
    strength: row.strength,
    // Decay is applied HERE, never written back: the row records what they
    // said, this records how much it should still drive a weight now.
    confidence: round - row.round >= SIGNAL_DECAY_ROUNDS ? row.confidence * SIGNAL_DECAY_FACTOR : row.confidence,
    source: row.source,
    reason: row.reason,
    evidence: row.evidenceTable && row.evidenceId ? { table: row.evidenceTable, id: row.evidenceId } : null,
  }));

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
    preferenceSignals,
    round,
    negotiationTurns: negotiationActions.length,
    // Same rule `clarificationAsked` follows: with no conversation there is
    // nowhere to ask, so the question is treated as already asked rather than
    // sending the round down a path with no way to actually put it.
    tradeOffAsked: Boolean(tradeOffAction) || !convo,
    conversationId: convo?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Write down what this round learned about what the applicant wants.
 *
 * APPEND-ONLY, and deliberately so. A signal row is never UPDATEd: when a
 * later round reads the same dimension the other way — "comprehensive cover,
 * whatever it costs" in round 1, "this is more than I want to spend" in round
 * 3 — the old row is stamped `superseded_at` and the new one is inserted
 * beside it. The history IS the learning record, and it is exactly the
 * argument the negotiation loop is having; collapsing it to a current value
 * would throw away the only evidence an advisor has that the applicant
 * changed their mind rather than that we misread them the first time.
 *
 * Runs inside the caller's transaction — never opens its own.
 */
async function persistSignals(applicationId: string, signals: PreferenceSignal[], round: number, now: Date): Promise<number> {
  if (signals.length === 0) return 0;

  const live = await db
    .select()
    .from(applicationPreferenceSignal)
    .where(and(eq(applicationPreferenceSignal.applicationId, applicationId), isNull(applicationPreferenceSignal.supersededAt)));

  let written = 0;
  for (const signal of signals) {
    // Already on file, same reading, same evidence — re-extracting the same
    // tagged priority every round must not stack up as emphasis, because
    // `calculateDynamicWeights` sums over signals.
    const duplicate = live.some(
      (row) =>
        row.dimension === signal.dimension &&
        row.direction === signal.direction &&
        row.source === signal.source &&
        (row.evidenceId ?? null) === (signal.evidence?.id ?? null),
    );
    if (duplicate) continue;

    // They have said the opposite of what is on file for this dimension.
    // That is the interesting case, and the one that must not be lost.
    const contradicted = live.filter((row) => row.dimension === signal.dimension && row.direction !== signal.direction);
    if (contradicted.length > 0) {
      await db
        .update(applicationPreferenceSignal)
        .set({ supersededAt: now })
        .where(inArray(applicationPreferenceSignal.id, contradicted.map((row) => row.id)));
    }

    await db.insert(applicationPreferenceSignal).values({
      applicationId,
      dimension: signal.dimension,
      direction: signal.direction,
      strength: signal.strength,
      confidence: signal.confidence,
      source: signal.source,
      reason: signal.reason,
      evidenceTable: signal.evidence?.table ?? null,
      evidenceId: signal.evidence?.id ?? null,
      round,
    });
    written++;
  }
  return written;
}

/**
 * A round the applicant rejected and the agent ANSWERED rather than rebuilt.
 *
 * Nothing about the live recommendation changes — that is the whole point of
 * a `convince`. What gets written is the fact that an argument was made:
 *
 *   application_preference_signal  what the objection itself told us
 *   conversation_action            `recommendation_negotiated` — the row the
 *                                  negotiation budget is COUNTED from, which
 *                                  is what makes the threshold survive a
 *                                  restart, a retry, or a second worker
 *   model_run                      the mechanical call, when a model made it
 */
export async function persistNegotiation(
  applicationId: string,
  negotiation: NegotiationResult,
  round: number,
  conversationId: string | null,
): Promise<void> {
  const now = new Date();

  await db.run(sql`begin`);
  try {
    await persistSignals(applicationId, negotiation.extractedSignals, round, now);

    // The mechanical call, when a model made one. No `ai_decision` alongside
    // it, deliberately: the live claim about which plan this applicant should
    // take has not changed. Only the conversation has.
    if (negotiation.servedBy) {
      await db
        .insert(modelRun)
        .values({
          purpose: "plan_recommendation",
          provider: PROVIDER,
          modelId: negotiation.servedBy ?? MODEL_ID,
          promptVersion: NEGOTIATE_PROMPT_VERSION,
          request: { applicationId, round },
          response: { outcome: negotiation.outcome, turnsUsed: negotiation.turnsUsed },
          latencyMs: negotiation.latencyMs,
          status: "ok",
        });
    }

    if (conversationId) {
      await db.insert(conversationAction).values({
        conversationId,
        actionType: "recommendation_negotiated",
        aiDecisionId: null,
        arguments: { round, outcome: negotiation.outcome, turnsUsed: negotiation.turnsUsed, reply: negotiation.reply },
        subjectType: "application",
        subjectId: applicationId,
        status: "succeeded",
        actorKind: "system",
        completedAt: now,
      });
    }

    await db.run(sql`commit`);
  } catch (error) {
    await db.run(sql`rollback`);
    throw error;
  }
}

/**
 * The applicant was asked which side of a hard gate they want to be on.
 *
 * Nothing is built and nothing is superseded — the round stopped at the
 * question. What gets written is the question itself, on the row whose mere
 * EXISTENCE is the durable "asked already" gate
 * (`recommendation_tradeoff_asked`, read back by `loadRecommendationInputs`),
 * so the applicant can never be asked this twice however many times the
 * background job is retried.
 *
 * No `model_run`: no model composed this. The question is the two plans' own
 * terms, arranged by `describeTradeOff` (lib/recommendation/tradeoff.ts).
 */
export async function persistTradeOff(
  applicationId: string,
  pending: PendingTradeOff,
  round: number,
  conversationId: string | null,
): Promise<{ asked: boolean }> {
  if (!conversationId) return { asked: false };
  const now = new Date();

  await db.run(sql`begin`);
  try {
    const [asked] = await db
      .insert(conversationAction)
      .values({
        conversationId,
        actionType: "recommendation_tradeoff_asked",
        arguments: {
          round,
          question: pending.question,
          options: pending.options,
          tradeOff: pending.tradeOff,
          promptVersion: TRADEOFF_PROMPT_VERSION,
        },
        subjectType: "application",
        subjectId: applicationId,
        status: "succeeded",
        actorKind: "system",
        completedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    await db.run(sql`commit`);
    return { asked: Boolean(asked) };
  } catch (error) {
    await db.run(sql`rollback`);
    throw error;
  }
}

/**
 * The question and its two options as they were actually asked, read back off
 * the authoritative row. `answerTradeOff` (app/applications/new/actions.ts)
 * uses this to write the applicant's own message in the words they pressed —
 * never in words the client sent up.
 */
export async function openTradeOffQuestion(
  applicationId: string,
): Promise<{ question: string; options: Record<TradeOffChoice, string> } | null> {
  const [asked] = await db
    .select({ arguments: conversationAction.arguments })
    .from(conversationAction)
    .where(
      and(
        eq(conversationAction.subjectType, "application"),
        eq(conversationAction.subjectId, applicationId),
        eq(conversationAction.actionType, "recommendation_tradeoff_asked"),
      ),
    )
    .limit(1);

  const args = asked?.arguments as { question?: string; options?: Record<TradeOffChoice, string> } | null;
  if (!args?.question || !args.options) return null;
  return { question: args.question, options: args.options };
}

/**
 * Their answer, turned into weights.
 *
 * The signals are NOT read out of the reply by a model — they are
 * `signalsForChoice`'s fixed set for whichever of the two options the answer
 * resolves to, decided before the question was ever asked. That is what makes
 * this loop closeable: a question asked because cost and cover were in
 * conflict comes back as the highest-confidence signals the system issues,
 * pointing at exactly the criteria that were in conflict.
 *
 * The `premium` answer is the one that does NOT simply re-run. Choosing the
 * cheaper plan means going without cover for something already declared on
 * the record, and a declared medical need is a fact, not a preference — it
 * cannot be dropped by a weight. So the signals are written (they are true,
 * and they should outlive this conversation) and an advisor is brought in to
 * handle what is really an amendment to the application. Quietly re-scoring
 * the applicant into a plan that does not cover their condition, because they
 * said the word "cheaper", is the one outcome this whole path exists to
 * prevent.
 */
export async function recordTradeOffAnswer(
  applicationId: string,
  conversationId: string,
  rawAnswer: string,
  actor: { userId: string },
  /**
   * Set when the applicant PRESSED one of the two buttons, which is the
   * normal path — there is nothing to interpret, so `readTradeOffAnswer`'s
   * keyword read is skipped entirely. It stays as the fallback for someone
   * who types a reply instead of pressing, and it fails safe when they do.
   */
  explicitChoice?: TradeOffChoice,
): Promise<{ recorded: boolean; choice: TradeOffChoice | null; needsAdvisor: boolean }> {
  const [asked] = await db
    .select()
    .from(conversationAction)
    .where(
      and(
        eq(conversationAction.subjectType, "application"),
        eq(conversationAction.subjectId, applicationId),
        eq(conversationAction.actionType, "recommendation_tradeoff_asked"),
      ),
    )
    .limit(1);
  if (!asked) return { recorded: false, choice: null, needsAdvisor: false };

  const args = asked.arguments as { round?: number; tradeOff?: TradeOff } | null;
  if (!args?.tradeOff) return { recorded: false, choice: null, needsAdvisor: false };

  const choice = explicitChoice ?? readTradeOffAnswer(rawAnswer);
  const signals = signalsForChoice(choice, args.tradeOff);
  const round = args.round ?? 1;
  const now = new Date();

  await db.run(sql`begin`);
  try {
    // Race-safe, same shape as the clarification answer: the partial unique
    // index means a second rapid reply writes nothing rather than a second
    // set of signals.
    const [recorded] = await db
      .insert(conversationAction)
      .values({
        conversationId,
        actionType: "recommendation_tradeoff_answered",
        arguments: { rawAnswer, choice, chosenBy: explicitChoice ? "button" : "free_text", planId: args.tradeOff.cheaperPlanId },
        subjectType: "application",
        subjectId: applicationId,
        status: "succeeded",
        actorKind: "applicant",
        actorUserId: actor.userId,
        completedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (!recorded) {
      await db.run(sql`commit`);
      return { recorded: false, choice, needsAdvisor: false };
    }

    await persistSignals(applicationId, signals, round, now);

    let needsAdvisor = false;
    if (choice === "premium") {
      needsAdvisor = true;
      await db.insert(reviewTask).values({
        subjectType: "application",
        subjectId: applicationId,
        reason:
          `The applicant would rather have ${args.tradeOff.cheaperPlanName} (AED ${args.tradeOff.cheaperPremium.toLocaleString("en-US")}) than keep ` +
          `${args.tradeOff.requirement}, which they declared on this application. That plan is only available to them if that ` +
          `requirement comes off the record — an amendment, not a re-score. Confirm with them before anything changes.`,
        priorityScore: 85,
        status: "open",
      });
    }

    await db.run(sql`commit`);
    return { recorded: true, choice, needsAdvisor };
  } catch (error) {
    await db.run(sql`rollback`);
    throw error;
  }
}

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
      await persistSignals(applicationId, outcome.extractedSignals, round, now);

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
    await persistSignals(applicationId, outcome.extractedSignals, round, now);

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
        // The weight set this recommendation was actually built under, and
        // the stated preference behind every adjustment. Stored here rather
        // than only in the trace so it survives: this is the answer to "why
        // was this applicant shown this plan", long after the tool
        // observations have stopped being interesting.
        weights: {
          base: outcome.weights.base,
          dynamic: outcome.weights.dynamic,
          confidence: outcome.weights.confidence,
          derivedFrom: outcome.weights.explanation.map((e) => ({
            criterionId: e.criterionId,
            baseWeight: e.baseWeight,
            shift: e.shift,
            finalWeight: e.finalWeight,
            statedPreferences: e.drivenBy.map((sig) => ({ direction: sig.direction, source: sig.source, reason: sig.reason })),
          })),
          promptVersion: SIGNALS_PROMPT_VERSION,
        },
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
export type RecommendationRun = {
  recommendation: RecommendationOutcome | null;
  /** Set when the applicant's rejection was ANSWERED rather than rebuilt around — `recommendation` is null in that case. */
  negotiation: NegotiationResult | null;
  /** Set when the round stopped to ask which side of a hard gate they want. Nothing was built. */
  tradeOff: PendingTradeOff | null;
};

export async function runRecommendation(
  applicationId: string,
  options: { force?: boolean } = {},
): Promise<RecommendationRun | null> {
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

  // The applicant is asking for a plan their own declared needs rule out.
  // Nothing was built and nothing is superseded — the round stopped at the
  // question, because no weighting admits an ineligible plan and every
  // rebuild would come back with something they did not ask for.
  if (outcome.tradeOff) {
    const { asked } = await persistTradeOff(applicationId, outcome.tradeOff, inputs.round, inputs.conversationId);
    return { recommendation: null, negotiation: null, tradeOff: asked ? outcome.tradeOff : null };
  }

  // A `convince` turn: the shortlist on file stands and the agent answered
  // the objection. There is no new recommendation to write, and writing one
  // anyway would supersede the very shortlist being defended.
  if (outcome.negotiation && outcome.negotiation.outcome === "convince") {
    await persistNegotiation(applicationId, outcome.negotiation, inputs.round, inputs.conversationId);
    return { recommendation: null, negotiation: outcome.negotiation, tradeOff: null };
  }

  if (!outcome.recommendation) return { recommendation: null, negotiation: outcome.negotiation, tradeOff: null };

  // A forced concede still spent a negotiation turn, and that turn has to be
  // COUNTED — otherwise the budget resets every time the agent gives in and
  // the loop this whole path exists to bound comes back.
  if (outcome.negotiation) {
    await persistNegotiation(applicationId, outcome.negotiation, inputs.round, inputs.conversationId);
  }

  await persistRecommendation(applicationId, outcome.recommendation, round, inputs.conversationId);
  return { recommendation: outcome.recommendation, negotiation: outcome.negotiation, tradeOff: null };
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
    let run: RecommendationRun | null = null;
    try {
      run = await runRecommendation(applicationId, options);
    } catch (error) {
      console.error("[recommendation] background run failed", applicationId, error);
      return;
    }
    const outcome = run?.recommendation ?? null;
    const negotiation = run?.negotiation ?? null;
    const tradeOff = run?.tradeOff ?? null;
    let conversationId: string | null = null;
    try {
      // Three different things can have happened, and they are three
      // different messages:
      //   a hard-gate conflict was found   -> the trade-off question, nothing built
      //   the agent answered an objection  -> its reply, no new card
      //   a clarifying question was asked  -> the question, nothing revealed
      //   a shortlist was built            -> the card
      conversationId = tradeOff
        ? await announceTradeOff(applicationId, tradeOff.question, tradeOff.options)
        : negotiation?.outcome === "convince" && negotiation.reply.length > 0
          ? await announceNegotiationReply(applicationId, negotiation.reply)
          : outcome?.pendingClarification
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
