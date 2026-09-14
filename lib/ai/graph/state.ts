// Graph state, declared once and shared by every node.
//
// The nodes live in ./nodes/*.ts and the graphs are wired together in
// ../graph.ts. Nothing else constructs a StateGraph — that is the whole point
// of the split: a node is a function of state, testable on its own, and the
// topology is readable in one file instead of being spread across whichever
// module happened to define the last node.
//
// Every reducer is last-write-wins. There is no accumulation here because
// durable state is not the graph: it is the conversation log in SQLite,
// replayed every turn (see lib/ai/intake-session.ts). The graph holds one
// turn's worth of thinking and then forgets it.

import { Annotation } from "@langchain/langgraph";
import type { ExtractedValue, ProposedQuestion } from "@/lib/ai/fields";
import type { PendingQuestion } from "@/lib/ai/questions";
import {
  emptyRecord,
  type Assessment,
  type AssessmentContext,
  type AssessmentRecord,
  type Catalogue,
  type CohortAssignment,
  type Fired,
  type Verdict,
} from "@/lib/assessment";
import { emptyDraft, type IntakeDraft } from "@/lib/intake";
import type { ConfidenceLevel } from "@/db/schema";
import type { QuoteRow } from "@/lib/recommendation";

/** Last-write-wins annotation — the only reducer shape this graph uses. */
const latest = <T>(fallback: () => T) =>
  Annotation<T>({ reducer: (_: T, next: T) => next, default: fallback });

export const IntakeState = Annotation.Root({
  transcript: latest<{ role: "applicant" | "assistant"; text: string }[]>(() => []),
  draft: latest<IntakeDraft>(emptyDraft),
  settled: latest<string[]>(() => []),
  reply: latest<string>(() => ""),
  accepted: latest<AcceptedValue[]>(() => []),
  rejected: latest<ExtractedValue[]>(() => []),
  proposed: latest<ProposedQuestion[]>(() => []),
  questions: latest<PendingQuestion[]>(() => []),
  recap: latest<string | null>(() => null),
  servedBy: latest<string | null>(() => null),
  latencyMs: latest<number>(() => 0),
  /** Set when the applicant answered a questionnaire — there is nothing to extract. */
  skipExtraction: latest<boolean>(() => false),
});

export type IntakeStateType = typeof IntakeState.State;

/** A value that survived validation and is safe to persist. */
export type AcceptedValue = ExtractedValue & {
  method: "stated" | "normalised";
  valueText: string;
};

// ---------------------------------------------------------------------------
// Assessment — what happens to an application the moment it exists
// ---------------------------------------------------------------------------

/**
 * Same discipline as the intake state: the graph holds one pass, and the
 * durable record is the rows the caller writes afterwards
 * (lib/ai/assessment-session.ts, lib/ai/recommendation-session.ts).
 *
 * `fired` is carried as rule+flag pairs rather than flags alone, because
 * `narrate` rewrites wording and `route` reads severity and confidence floors.
 * One of those is allowed to change what the broker reads; the other decides
 * where the application goes, and they must not be able to touch each other.
 *
 * Recommendation is not a second, disjoint state: `price` / `recommend` /
 * `verify` / `recommendationGate` (lib/ai/graph/nodes/*) read `record`,
 * `catalogue` and `cohort` directly off THIS state, and read the flags a
 * declared need runs into off `verdict.flags` — the same channels assessment
 * already populated. It is a later phase of the one record, not a different
 * one, so it attaches to the same annotation rather than re-declaring
 * `record`/`catalogue`/`cohort` a second time under new names.
 */
export const AssessmentState = Annotation.Root({
  record: latest<AssessmentRecord>(emptyRecord),
  catalogue: latest<Catalogue>(() => ({ plans: [], admits: new Set<string>() })),
  context: latest<AssessmentContext>(() => ({ today: "", openApplicationsForPerson: 0 })),

  cohort: latest<CohortAssignment | null>(() => null),
  fired: latest<Fired[]>(() => []),
  verdict: latest<Verdict | null>(() => null),

  /** Which rules the model reworded, for the audit row. */
  narrated: latest<string[]>(() => []),
  /** The model's one-line "why this is in front of you", when it wrote one. */
  queueLine: latest<string | null>(() => null),
  servedBy: latest<string | null>(() => null),
  latencyMs: latest<number>(() => 0),

  // -- Recommendation phase (lib/ai/graph/nodes/{price,recommend,verify,recommendation-gate}.ts) --
  /** Prior rounds' rejected shortlists, read by the `previous_rounds` tool. Round 2+ only. */
  previousRounds: latest<{ round: number; rejectedPlanIds: string[]; reason: string }[]>(() => []),
  quotes: latest<QuoteRow[]>(() => []),
  /** One entry per tool-call step of the agent's loop (doc §3.6/§4.2). */
  trace: latest<RecommendationTraceStep[]>(() => []),
  shortlist: latest<ShortlistPick[]>(() => []),
  rejections: latest<ShortlistRejection[]>(() => []),
  brokerReasoning: latest<string | null>(() => null),
  memberReasoning: latest<string | null>(() => null),
  /** The recommendation's own confidence — distinct from `verdict.confidence`, which is the assessment's. */
  recoConfidence: latest<ConfidenceLevel>(() => "low"),
  recoUncertaintyReason: latest<string | null>(() => null),
  /** Set when the tool loop did not complete and the deterministic path ran instead. */
  fellBackTo: latest<string | null>(() => null),
  /** Set when `verify` finds a figure with no matching observation. */
  verifyFailed: latest<boolean>(() => false),
});

export type AssessmentStateType = typeof AssessmentState.State;
/** Recommendation reads and writes the same state assessment does — see the comment above `AssessmentState`. */
export type RecommendationStateType = AssessmentStateType;

export type AssessmentOutcome = Assessment & {
  /** True when `gate` stopped the graph and a human now owns this. */
  routedToReview: boolean;
  narrated: string[];
  servedBy: string | null;
  latencyMs: number;
};

// ---------------------------------------------------------------------------
// Recommendation — the agent's shortlist, built over a tool-call loop
// ---------------------------------------------------------------------------

/** One step of the JSON action loop (doc §3.6/§4.2) — a tool call, its validation, and what it returned. */
export type RecommendationTraceStep = {
  step: number;
  thought: string;
  tool: string;
  args: unknown;
  /** "ok", or the validation error that rejected this call. */
  validation: string;
  observationSummary: string;
  latencyMs: number;
};

export type ShortlistPick = { planId: string; rank: number };
export type ShortlistRejection = { planId: string; reason: string };

export type RecommendationOutcome = {
  quotes: QuoteRow[];
  shortlist: ShortlistPick[];
  rejections: ShortlistRejection[];
  brokerReasoning: string;
  memberReasoning: string;
  confidence: ConfidenceLevel;
  uncertaintyReason: string | null;
  trace: RecommendationTraceStep[];
  fellBackTo: string | null;
  verifyFailed: boolean;
  /** True when `recommendationGate` interrupted — an advisor owns this before the applicant sees it. */
  routedToReview: boolean;
  servedBy: string | null;
  latencyMs: number;
};

export type Turn = {
  /** What the assistant says back, in its own words. */
  reply: string;
  accepted: AcceptedValue[];
  /** Values the model proposed but we refused (inference on a gated field). */
  rejected: ExtractedValue[];
  questions: PendingQuestion[];
  draft: IntakeDraft;
  /** True when nothing is missing — the recap is on screen awaiting a yes. */
  readyToSubmit: boolean;
  recap: string | null;
  servedBy: string | null;
  latencyMs: number;
};
