// Every graph in the system is wired here, and only here.
//
// Nodes live in ./graph/nodes/*.ts — each one a plain function of state, with
// its own reasoning written next to it. This file holds the topology, so the
// shape of the system is readable in one screen instead of being inferred from
// whichever module happened to define the last node.
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
import { ask } from "./graph/nodes/ask";
import { classify } from "./graph/nodes/classify";
import { clarify, routeAfterVerify } from "./graph/nodes/clarify";
import { confirm } from "./graph/nodes/confirm";
import { converse, gaps } from "./graph/nodes/converse";
import { gate } from "./graph/nodes/gate";
import { narrate } from "./graph/nodes/narrate";
import { price } from "./graph/nodes/price";
import { recommend } from "./graph/nodes/recommend";
import { recommendationGate } from "./graph/nodes/recommendation-gate";
import { gated, route } from "./graph/nodes/route";
import { validate } from "./graph/nodes/validate";
import { verify } from "./graph/nodes/verify";
import {
  AssessmentState,
  IntakeState,
  type AssessmentOutcome,
  type ClarificationAnswer,
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

const assessmentGraph = new StateGraph(AssessmentState)
  .addNode("validate", validate)
  .addNode("classify", classify)
  .addNode("narrate", narrate)
  .addNode("route", route)
  .addNode("gate", gate)
  .addEdge(START, "validate")
  .addEdge("validate", "classify")
  .addEdge("classify", "narrate")
  .addEdge("narrate", "route")
  .addConditionalEdges("route", gated, { gate: "gate", clear: END })
  .addEdge("gate", END);

/**
 * Assess one application: validate the record, classify it, let the model
 * improve the broker's wording, then decide where it goes.
 *
 * Returns the whole outcome rather than writing anything — persistence is the
 * caller's job (lib/ai/assessment-session.ts), the same division intake uses,
 * so this stays runnable against the supplied fixtures with no database at all.
 */
export async function runAssessment(input: {
  record: AssessmentRecord;
  catalogue: Catalogue;
  context: AssessmentContext;
}): Promise<AssessmentOutcome> {
  const compiled = assessmentGraph.compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: crypto.randomUUID() } };

  const result = await compiled.invoke(input, config);

  // `gate` interrupted, so the graph is paused rather than finished. The
  // verdict is already in state — the pause is the signal, not the payload.
  const snapshot = await compiled.getState(config);
  const routedToReview = snapshot.tasks.some((task) => (task.interrupts ?? []).length > 0);

  // A verdict is only absent if the graph was cut short before `route`, which
  // nothing in the topology does. Falling back keeps the return type honest
  // rather than asserting a non-null through it.
  const verdict = result.verdict ?? {
    flags: [],
    confidence: "low" as const,
    uncertaintyReason: "Assessment did not complete.",
    gate: "needs_review" as const,
    priorityScore: 100,
    queueReason: "Assessment did not complete — needs a person.",
  };

  return {
    cohort: result.cohort ?? assignCohort(input.record),
    ...verdict,
    routedToReview,
    narrated: result.narrated ?? [],
    servedBy: result.servedBy ?? null,
    latencyMs: result.latencyMs ?? 0,
  };
}

// Recommendation is a later phase of the SAME state assessment uses (see the
// comment on `AssessmentState` in graph/state.ts) — it attaches `price` /
// `recommend` / `verify` / `clarify` / `recommendationGate` onto that one
// annotation rather than declaring a second, disjoint state. `record`,
// `catalogue` and `cohort` are the very fields `validate`/`classify` already
// populated; `recommend` reads the flags a declared need ran into off
// `verdict.flags`, the same channel `route`/`gate` already read.
const recommendationGraph = new StateGraph(AssessmentState)
  .addNode("price", price)
  .addNode("recommend", recommend)
  .addNode("verify", verify)
  .addNode("clarify", clarify)
  .addNode("recommendationGate", recommendationGate)
  .addEdge(START, "price")
  .addEdge("price", "recommend")
  .addEdge("recommend", "verify")
  .addConditionalEdges("verify", routeAfterVerify, { clarify: "clarify", gate: "recommendationGate", present: END })
  .addEdge("clarify", END)
  .addEdge("recommendationGate", END);

/**
 * Price all three plans, let the agent build a shortlist over its tool
 * budget (or fall back to the deterministic ranking), then verify it.
 *
 * Returns the whole outcome rather than writing anything — persistence is the
 * caller's job (lib/ai/recommendation-session.ts), the same division
 * assessment and intake both use, so this stays runnable against the
 * supplied fixtures with no database at all.
 *
 * `cohort` and `verdict` are the assessment's own — recommendation does not
 * re-derive them, it reads what `runAssessment` already produced and the
 * caller already persisted.
 */
export async function runRecommendation(input: {
  record: AssessmentRecord;
  catalogue: Catalogue;
  cohort: CohortAssignment;
  verdict: Verdict;
  previousRounds: PreviousRound[];
  /** Loaded fresh from `conversation_action` rows every call — never carried over in graph/checkpointer state. See lib/ai/graph/nodes/clarify.ts. */
  clarificationAsked: boolean;
  clarification: ClarificationAnswer | null;
}): Promise<RecommendationOutcome> {
  const compiled = recommendationGraph.compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: crypto.randomUUID() } };

  const result = await compiled.invoke(input, config);

  // Either `clarify` or `recommendationGate` interrupted, so the graph is
  // paused rather than finished — same read as runAssessment's gate, just
  // split two ways by inspecting the interrupt VALUE's shape: only `clarify`
  // ever sets `kind: "clarify"` (a validated question); a rejected/failed
  // clarification attempt interrupts with the same shape `recommendationGate`
  // uses, so it is indistinguishable from — and handled identically to — an
  // ordinary advisor gate.
  const snapshot = await compiled.getState(config);
  const interrupts = snapshot.tasks.flatMap((task) => task.interrupts ?? []);
  const clarifyInterrupt = interrupts
    .map((i) => i.value as { kind?: string; target?: string; question?: string } | undefined)
    .find((v) => v?.kind === "clarify");
  const routedToReview = interrupts.length > 0 && !clarifyInterrupt;
  const pendingClarification =
    clarifyInterrupt && clarifyInterrupt.target && clarifyInterrupt.question
      ? { target: clarifyInterrupt.target as CriterionId, question: clarifyInterrupt.question }
      : null;

  return {
    quotes: result.quotes ?? [],
    shortlist: result.shortlist ?? [],
    rejections: result.rejections ?? [],
    brokerReasoning: result.brokerReasoning ?? "",
    memberReasoning: result.memberReasoning ?? "",
    confidence: result.recoConfidence ?? "low",
    uncertaintyReason: result.recoUncertaintyReason ?? null,
    trace: result.trace ?? [],
    fellBackTo: result.fellBackTo ?? null,
    verifyFailed: result.verifyFailed ?? false,
    routedToReview,
    pendingClarification,
    servedBy: result.servedBy ?? null,
    latencyMs: result.latencyMs ?? 0,
  };
}
