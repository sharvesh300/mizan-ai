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
//     price ──> recommend ──> verify ──┬──> clarify           (interrupt: the applicant owns one question)
//                                      ├──> recommendationGate (interrupt: an advisor owns it)
//                                      └──> END  (present to the applicant)
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
import { clarify, routeAfterVerify } from "./graph/nodes/clarify";
import {
  AssessmentState,
  IntakeState,
  type AssessmentOutcome,
  type ClarificationAnswer,
  type PolicyPipelineOutcome,
  type RecommendationOutcome,
  type Turn,
} from "./graph/state";
import type { PreviousRound } from "./tools/plans";
import type { PendingQuestion } from "./questions";
import type { CriterionId } from "@/lib/recommendation";
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
 * Unified post-submission policy pipeline graph:
 *
 * Combines assessment and recommendation into a single topological pipeline:
 *
 *   START ──> [verdict exists? price : validate]
 *                 │
 *                 ├─> price ──> recommend ──> verify ──┬──[clarify]─> clarify (interrupt: applicant) ──> END
 *                 │                                    ├──[gate]────> recommendationGate (interrupt: advisor) ──> END
 *                 │                                    └──[present]─> END
 *                 │
 *                 └─> validate ──> classify ──> narrate ──> route ──┬──[gated]─────────> gate (interrupt: advisor) ──> END
 *                                                                   ├──[assessmentOnly]─> END
 *                                                                   └──[clear]─────────> price (flows into recommendation above)
 */
export const policyPipelineGraph = new StateGraph(AssessmentState)
  .addNode("validate", validate)
  .addNode("classify", classify)
  .addNode("narrate", narrate)
  .addNode("route", route)
  .addNode("gate", gate)
  .addNode("price", price)
  .addNode("recommend", recommend)
  .addNode("verify", verify)
  .addNode("clarify", clarify)
  .addNode("recommendationGate", recommendationGate)
  .addConditionalEdges(START, (state) => (state.verdict ? "price" : "validate"))
  .addEdge("validate", "classify")
  .addEdge("classify", "narrate")
  .addEdge("narrate", "route")
  .addConditionalEdges("route", (state) => {
    if (gated(state) === "gate") return "gate";
    if (state.assessmentOnly) return END;
    return "price";
  }, {
    gate: "gate",
    price: "price",
    [END]: END,
  })
  .addEdge("gate", END)
  .addEdge("price", "recommend")
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

  const isRecommendationGated = interrupts.length > 0 && !isAssessmentGated && !clarifyInterrupt;

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
      servedBy: result.servedBy ?? null,
      latencyMs: result.latencyMs ?? 0,
    };
  }

  let phase: PolicyPipelineOutcome["phase"] = "recommended";
  if (isAssessmentGated || isRecommendationGated) {
    phase = "gated_for_review";
  } else if (clarifyInterrupt) {
    phase = "clarification_required";
  }

  return {
    phase,
    assessment,
    recommendation,
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
}): Promise<RecommendationOutcome> {
  const outcome = await runPolicyPipeline({
    record: input.record,
    catalogue: input.catalogue,
    context: { today: "", openApplicationsForPerson: 0 },
    cohort: input.cohort,
    verdict: input.verdict,
    previousRounds: input.previousRounds,
    clarificationAsked: input.clarificationAsked,
    clarification: input.clarification,
  });

  if (!outcome.recommendation) {
    throw new Error("Recommendation pipeline failed to produce an outcome.");
  }
  return outcome.recommendation;
}

