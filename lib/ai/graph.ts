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
// They are two graphs, not one, because they are separated by a human
// decision and a database write: intake ends when the applicant says "send
// it", and assessment starts from the row that created. Quote and recommend
// attach to the assessment graph as their nodes land.

import "server-only";
import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { ask } from "./graph/nodes/ask";
import { classify } from "./graph/nodes/classify";
import { confirm } from "./graph/nodes/confirm";
import { converse, gaps } from "./graph/nodes/converse";
import { gate } from "./graph/nodes/gate";
import { narrate } from "./graph/nodes/narrate";
import { gated, route } from "./graph/nodes/route";
import { validate } from "./graph/nodes/validate";
import {
  AssessmentState,
  IntakeState,
  type AssessmentOutcome,
  type Turn,
} from "./graph/state";
import type { PendingQuestion } from "./questions";
import { assignCohort, type AssessmentContext, type AssessmentRecord, type Catalogue } from "@/lib/assessment";
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
