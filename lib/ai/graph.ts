// Every graph in the system is wired here, and only here.
//
// Nodes live in ./graph/nodes/{intake,assessment,recommendation,clarify}.ts.
// This file holds the topology, so the shape of the system is readable in one
// screen instead of being inferred from whichever module happened to define
// the last node.
//
//   INTAKE (the applicant is typing)
//     converse ──> gaps ──┬──> ask     (interrupt: hand control back to the human)
//                         └──> confirm (nothing missing — recap and submit)
//
//   ASSESSMENT (the application now exists)
//     validate ──> classify ──> narrate ──> route ──┬──> gate (interrupt: an advisor owns it)
//                                                   └──> END  (clean — advance to quoting)
//
//   RECOMMENDATION (the record is clean)
//     signals ─┬─> price ───┐
//              ├─> weights ─┴─> recommend ──> verify ──┬──> clarify            (interrupt: applicant)
//              │                                       ├──> recommendationGate (interrupt: advisor)
//              │                                       └──> END  (present)
//              ├─> tradeOff ──> END                    (interrupt: the applicant owns a fork)
//              ├─> negotiate ─┬─> END                  (the shortlist stands, with an answer)
//              │              └─> price ∥ weights      (conceded — rebuild around what they said)
//              └─> compromise ─> verify                (rounds exhausted; closest plan + an advisor)
//
// Intake is compiled and invoked separately from the other two because it is
// the applicant's own graph, on its own state shape. Assessment and
// recommendation are compiled as separate topologies too — they are
// separated by a human decision and a database write, exactly like intake and
// assessment are (assessment starts from the row intake created; recommendation
// starts only once an advisor's gate is clear, which may be a different
// request entirely) — but recommendation's nodes ATTACH to assessment's own
// state (`AssessmentState` in ./graph/state.ts) rather than declaring a
// second one: it reads `record`/`catalogue`/`cohort`/`verdict.flags`, the
// same channels `validate`/`classify` already populated, because a
// recommendation is a later phase of the same record, not a different one.

import "server-only";
import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { ask, confirm, converse, gaps } from "./graph/nodes/intake";
import { classify, gate, gated, narrate, route, validate } from "./graph/nodes/assessment";
import { price, recommend, recommendationGate, verify } from "./graph/nodes/recommendation";
import { signals } from "./graph/nodes/signals";
import { weights } from "./graph/nodes/weights";
import { compromise, MAX_NEGOTIATION_TURNS, negotiate, routeAfterNegotiate, routeAfterSignals } from "./graph/nodes/negotiate";
import { tradeOff } from "./graph/nodes/tradeoff";
import { clarify, routeAfterVerify } from "./graph/nodes/clarify";
import {
  AssessmentState,
  IntakeState,
  type AssessmentOutcome,
  type ClarificationAnswer,
  type NegotiationResult,
  type PendingTradeOff,
  type PolicyPipelineOutcome,
  type RecommendationOutcome,
  type Turn,
} from "./graph/state";
import type { PreviousRound } from "./tools/plans";
import type { PendingQuestion } from "./questions";
import type { CriterionId, PreferenceSignal } from "@/lib/recommendation";
import {
  assignCohort,
  type AssessmentContext,
  type AssessmentRecord,
  type Catalogue,
  type CohortAssignment,
  type Verdict,
} from "@/lib/assessment";
import type { IntakeDraft } from "@/lib/intake";

const intakeGraph = new StateGraph(IntakeState)
  .addNode("converse", converse)
  .addNode("ask", ask)
  .addNode("confirm", confirm)
  .addEdge(START, "converse")
  .addConditionalEdges("converse", gaps, ["ask", "confirm"])
  .addEdge("ask", END)
  .addEdge("confirm", END);

/**
 * Run one intake turn. A fresh checkpointer per turn is deliberate: durable
 * state is the conversation log in SQLite, replayed by the caller, so there is
 * no second copy of the truth to drift.
 */
export async function runIntakeTurn(input: {
  transcript: { role: "applicant" | "assistant"; text: string }[];
  draft: IntakeDraft;
  settled: string[];
  /** True when this turn follows a questionnaire submission. */
  skipExtraction?: boolean;
}): Promise<Turn> {
  const compiled = intakeGraph.compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: crypto.randomUUID() } };

  const result = await compiled.invoke(input, config);

  // `ask` interrupted, so its questions are on the paused task rather than in
  // the returned state. Read them off the snapshot.
  const snapshot = await compiled.getState(config);
  const paused = snapshot.tasks
    .flatMap((task) => task.interrupts ?? [])
    .flatMap((i) => (i.value as { questions?: PendingQuestion[] } | undefined)?.questions ?? []);

  const questions = paused.length > 0 ? paused : result.questions;

  return {
    reply: result.reply ?? "",
    accepted: result.accepted ?? [],
    rejected: result.rejected ?? [],
    questions,
    draft: result.draft,
    readyToSubmit: questions.length === 0,
    recap: result.recap ?? null,
    servedBy: result.servedBy ?? null,
    latencyMs: result.latencyMs ?? 0,
  };
}

/**
 * Unified post-submission policy pipeline graph.
 *
 *   START ──> [verdict exists? signals : validate]
 *                 │
 *                 ├─> signals ──┬──[build]──────> price   ─┐
 *                 │             │                 weights  ├─> recommend ──> verify ──┬──[clarify]─> clarify ──> END
 *                 │             │                          │                          ├──[gate]────> recommendationGate ──> END
 *                 │             │                          │                          └──[present]─> END
 *                 │             ├──[tradeOff]───> tradeOff (interrupt: which side of a hard gate?) ──> END
 *                 │             ├──[negotiate]──> negotiate ┬──[convince]─> END
 *                 │             │                           └──[concede]──> price ∥ weights (above)
 *                 │             └──[compromise]─> compromise ─────────────> verify (above)
 *                 │
 *                 └─> validate ──> classify ──> narrate ──> route ──┬──[gated]─────────> gate ──> END
 *                                                                   ├──[assessmentOnly]─> END
 *                                                                   └──[clear]─────────> signals
 *
 * `price` and `weights` fan out in parallel and fan back in at `recommend`.
 * They are independent (`price` is arithmetic over the panel; `weights` is
 * arithmetic over the baseline and the signals) and they write disjoint
 * channels — `quotes` versus `dynamicWeights`/`weightExplanation`/
 * `weightConfidence` — so the last-write-wins reducers never have to
 * arbitrate and the fan-in is order-independent.
 *
 * `negotiate` sits BEFORE that fan-out rather than after it, and this is
 * structural, not stylistic: a `convince` outcome ends the turn, and if
 * `negotiate` hung off `weights` the parallel `price` branch would still
 * trigger `recommend` on its own edge and build a shortlist nobody asked for.
 * Branching at `signals` keeps exactly one path live per round.
 */
export const policyPipelineGraph = new StateGraph(AssessmentState)
  .addNode("validate", validate)
  .addNode("classify", classify)
  .addNode("narrate", narrate)
  .addNode("route", route)
  .addNode("gate", gate)
  .addNode("signals", signals)
  .addNode("price", price)
  .addNode("weights", weights)
  .addNode("negotiate", negotiate)
  .addNode("tradeOff", tradeOff)
  .addNode("compromise", compromise)
  .addNode("recommend", recommend)
  .addNode("verify", verify)
  .addNode("clarify", clarify)
  .addNode("recommendationGate", recommendationGate)
  .addConditionalEdges(START, (state) => (state.verdict ? "signals" : "validate"))
  .addEdge("validate", "classify")
  .addEdge("classify", "narrate")
  .addEdge("narrate", "route")
  .addConditionalEdges("route", (state) => {
    if (gated(state) === "gate") return "gate";
    if (state.assessmentOnly) return END;
    return "signals";
  }, {
    gate: "gate",
    signals: "signals",
    [END]: END,
  })
  .addEdge("gate", END)
  // The fan-out. Returning an array sends the turn down both branches in one
  // superstep; `recommend` waits for both before it runs.
  .addConditionalEdges("signals", routeAfterSignals, ["price", "weights", "negotiate", "compromise", "tradeOff"])
  .addConditionalEdges("negotiate", (state) => (routeAfterNegotiate(state) === "convince" ? END : ["price", "weights"]), [
    "price",
    "weights",
    END,
  ])
  .addEdge("tradeOff", END)
  .addEdge("compromise", "verify")
  .addEdge("price", "recommend")
  .addEdge("weights", "recommend")
  .addEdge("recommend", "verify")
  .addConditionalEdges("verify", routeAfterVerify, {
    clarify: "clarify",
    gate: "recommendationGate",
    present: END,
  })
  .addEdge("clarify", END)
  .addEdge("recommendationGate", END);

/**
 * Run the unified policy pipeline:
 * Evaluates record integrity and constraint rules, and if clean of flags,
 * quotes all plans and executes the recommendation agent.
 */
export async function runPolicyPipeline(input: {
  record: AssessmentRecord;
  catalogue: Catalogue;
  context: AssessmentContext;
  cohort?: CohortAssignment | null;
  verdict?: Verdict | null;
  previousRounds?: PreviousRound[];
  clarificationAsked?: boolean;
  clarification?: ClarificationAnswer | null;
  assessmentOnly?: boolean;
  /** Live rows from `application_preference_signal`, loaded by the caller. Never carried in the checkpointer. */
  preferenceSignals?: PreferenceSignal[];
  /** 1-based; `previousRounds.length + 1` unless the caller knows better. The negotiation thresholds are read off this and `negotiationTurns`. */
  round?: number;
  /** How many times the agent has already defended a shortlist to this applicant, counted from rows. */
  negotiationTurns?: number;
  /** Whether the one trade-off question has already been asked, from its row's existence. */
  tradeOffAsked?: boolean;
}): Promise<PolicyPipelineOutcome> {
  const compiled = policyPipelineGraph.compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: crypto.randomUUID() } };

  const result = await compiled.invoke(
    {
      ...input,
      cohort: input.cohort ?? null,
      verdict: input.verdict ?? null,
      previousRounds: input.previousRounds ?? [],
      clarificationAsked: input.clarificationAsked ?? false,
      clarification: input.clarification ?? null,
      assessmentOnly: input.assessmentOnly ?? false,
      preferenceSignals: input.preferenceSignals ?? [],
      round: input.round ?? (input.previousRounds?.length ?? 0) + 1,
      negotiationTurns: input.negotiationTurns ?? 0,
      tradeOffAsked: input.tradeOffAsked ?? false,
    },
    config,
  );

  const snapshot = await compiled.getState(config);
  const interrupts = snapshot.tasks.flatMap((task) => task.interrupts ?? []);

  const isAssessmentGated = interrupts.some((i) => {
    const v = i.value as { gate?: string; priorityScore?: number } | undefined;
    return v?.gate !== undefined;
  });

  const clarifyInterrupt = interrupts
    .map((i) => i.value as { kind?: string; target?: string; question?: string } | undefined)
    .find((v) => v?.kind === "clarify");

  const tradeOffInterrupt = interrupts
    .map((i) => i.value as PendingTradeOff & { kind?: string } | undefined)
    .find((v) => v?.kind === "tradeoff");

  const isRecommendationGated = interrupts.length > 0 && !isAssessmentGated && !clarifyInterrupt && !tradeOffInterrupt;

  const verdict = result.verdict ?? {
    flags: [],
    confidence: "low" as const,
    uncertaintyReason: "Assessment did not complete.",
    gate: "needs_review" as const,
    priorityScore: 100,
    queueReason: "Assessment did not complete — needs a person.",
  };

  const assessment: AssessmentOutcome = {
    cohort: result.cohort ?? assignCohort(input.record),
    ...verdict,
    routedToReview: isAssessmentGated,
    narrated: result.narrated ?? [],
    servedBy: result.servedBy ?? null,
    latencyMs: result.latencyMs ?? 0,
  };

  const pendingTradeOff: PendingTradeOff | null =
    tradeOffInterrupt && tradeOffInterrupt.question && tradeOffInterrupt.tradeOff
      ? { question: tradeOffInterrupt.question, options: tradeOffInterrupt.options, tradeOff: tradeOffInterrupt.tradeOff }
      : null;

  let recommendation: RecommendationOutcome | null = null;
  if (!isAssessmentGated && result.quotes && result.quotes.length > 0) {
    const pendingClarification =
      clarifyInterrupt && clarifyInterrupt.target && clarifyInterrupt.question
        ? { target: clarifyInterrupt.target as CriterionId, question: clarifyInterrupt.question }
        : null;

    recommendation = {
      quotes: result.quotes,
      shortlist: result.shortlist ?? [],
      rejections: result.rejections ?? [],
      brokerReasoning: result.brokerReasoning ?? "",
      memberReasoning: result.memberReasoning ?? "",
      confidence: result.recoConfidence ?? "low",
      uncertaintyReason: result.recoUncertaintyReason ?? null,
      trace: result.trace ?? [],
      fellBackTo: result.fellBackTo ?? null,
      verifyFailed: result.verifyFailed ?? false,
      routedToReview: isRecommendationGated,
      pendingClarification,
      pendingTradeOff,
      extractedSignals: result.extractedSignals ?? [],
      weights: {
        base: result.baseWeights ?? [],
        dynamic: result.dynamicWeights ?? [],
        explanation: result.weightExplanation ?? [],
        confidence: result.weightConfidence ?? 1,
      },
      servedBy: result.servedBy ?? null,
      latencyMs: result.latencyMs ?? 0,
    };
  }

  // `convince` is the one path that ends the turn with no new shortlist at
  // all: the agent answered the objection and the shortlist on file stands.
  // `concede` fell through to a rebuild, so it is not reported as negotiation
  // — the new recommendation IS the answer.
  const negotiation: NegotiationResult | null =
    result.negotiationOutcome != null
      ? {
          outcome: result.negotiationOutcome,
          reply: result.negotiationReply ?? "",
          turnsUsed: result.negotiationTurns ?? 0,
          forced: result.negotiationOutcome === "concede" && (result.negotiationTurns ?? 0) >= MAX_NEGOTIATION_TURNS,
          extractedSignals: result.extractedSignals ?? [],
          servedBy: result.servedBy ?? null,
          latencyMs: result.latencyMs ?? 0,
        }
      : null;

  let phase: PolicyPipelineOutcome["phase"] = "recommended";
  if (negotiation?.outcome === "convince") {
    phase = "negotiated";
  } else if (isAssessmentGated || isRecommendationGated) {
    // The compromise round always gates (it sets `fellBackTo`), so it is
    // reported as its own phase rather than as an ordinary review: the caller
    // presents it differently, and it is the terminal state of the whole
    // negotiation, not a quality check on a fresh shortlist.
    phase = result.fellBackTo === "negotiation exhausted" ? "exhausted" : "gated_for_review";
  } else if (pendingTradeOff) {
    // `tradeOff` interrupts before `price` ever runs, so there is no
    // recommendation object to carry it — the phase and the outcome's own
    // field are how the caller finds out.
    phase = "tradeoff_required";
  } else if (clarifyInterrupt) {
    phase = "clarification_required";
  }

  return {
    phase,
    assessment,
    recommendation,
    negotiation,
    tradeOff: pendingTradeOff,
  };
}

/**
 * Assess one application: validate the record, classify it, let the model
 * improve the broker's wording, then decide where it goes.
 * Runs assessment only through the unified policy pipeline.
 */
export async function runAssessment(input: {
  record: AssessmentRecord;
  catalogue: Catalogue;
  context: AssessmentContext;
}): Promise<AssessmentOutcome> {
  const outcome = await runPolicyPipeline({ ...input, assessmentOnly: true });
  return outcome.assessment;
}

/**
 * Price all plans, let the agent build a shortlist, and verify it.
 * Runs recommendation through the unified policy pipeline starting at price.
 */
export async function runRecommendation(input: {
  record: AssessmentRecord;
  catalogue: Catalogue;
  cohort: CohortAssignment;
  verdict: Verdict;
  previousRounds: PreviousRound[];
  clarificationAsked: boolean;
  clarification: ClarificationAnswer | null;
  preferenceSignals: PreferenceSignal[];
  round: number;
  negotiationTurns: number;
  tradeOffAsked: boolean;
}): Promise<{
  phase: PolicyPipelineOutcome["phase"];
  recommendation: RecommendationOutcome | null;
  negotiation: NegotiationResult | null;
  tradeOff: PendingTradeOff | null;
}> {
  const outcome = await runPolicyPipeline({
    record: input.record,
    catalogue: input.catalogue,
    context: { today: "", openApplicationsForPerson: 0 },
    cohort: input.cohort,
    verdict: input.verdict,
    previousRounds: input.previousRounds,
    clarificationAsked: input.clarificationAsked,
    clarification: input.clarification,
    preferenceSignals: input.preferenceSignals,
    round: input.round,
    negotiationTurns: input.negotiationTurns,
    tradeOffAsked: input.tradeOffAsked,
  });

  // A `negotiated` turn legitimately produces no recommendation: the agent
  // answered the objection and the shortlist already on file stands. Only a
  // round that was supposed to BUILD one and did not is a failure.
  // `negotiated` and `tradeoff_required` legitimately produce no
  // recommendation: one answered an objection and left the shortlist on file
  // standing, the other stopped to ask a question before building anything.
  // Only a round that was supposed to BUILD one and did not is a failure.
  if (!outcome.recommendation && outcome.phase !== "negotiated" && outcome.phase !== "tradeoff_required") {
    throw new Error("Recommendation pipeline failed to produce an outcome.");
  }
  return { phase: outcome.phase, recommendation: outcome.recommendation, negotiation: outcome.negotiation, tradeOff: outcome.tradeOff };
}

