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
import type { CommitPlan, ServicingInput, ServicingTurn } from "@/lib/ai/graph/nodes/servicing";
import type { ServicingToolContext } from "@/lib/ai/tools/servicing";
import type { CriterionId, CriterionWeight, PreferenceSignal, QuoteRow, TradeOff, TradeOffChoice, WeightExplanation } from "@/lib/recommendation";

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
  /** When true, the unified policy pipeline halts after routing instead of running recommendation. */
  assessmentOnly: latest<boolean>(() => false),

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

  // -- Preference signals and dynamic weights (lib/ai/graph/nodes/{signals,weights}.ts) --
  /**
   * Every LIVE signal for this application: the ones loaded from
   * `application_preference_signal` rows merged with whatever `signals`
   * extracted this round. Durable state is the rows, as always — this is one
   * turn's working copy of them.
   */
  preferenceSignals: latest<PreferenceSignal[]>(() => []),
  /** Only what THIS round produced — what the session writes down. A subset of `preferenceSignals`. */
  extractedSignals: latest<PreferenceSignal[]>(() => []),
  /** Signal candidates the model proposed and `validateSignals` refused, with the reason. Trace only. */
  signalsDropped: latest<string[]>(() => []),

  /** The cohort baseline, before any preference moved it (`suggestDefaultWeights`). */
  baseWeights: latest<CriterionWeight[]>(() => []),
  /** What `score_plans` is actually held to this round (`calculateDynamicWeights`). */
  dynamicWeights: latest<CriterionWeight[]>(() => []),
  /** Per criterion: base, shift, final, and every signal that moved it. */
  weightExplanation: latest<WeightExplanation[]>(() => []),
  /** 0..1 — how much of the weight set rests on signals we are sure of. 1 when nothing moved it. */
  weightConfidence: latest<number>(() => 1),

  // -- Negotiation (lib/ai/graph/nodes/negotiate.ts) --
  /** 1-based, matching `recommendation.version`. Rebuilt from rows, never carried in the checkpointer. */
  round: latest<number>(() => 1),
  /** How many times the agent has already defended a shortlist to this applicant. Also rebuilt from rows. */
  negotiationTurns: latest<number>(() => 0),
  /** What the agent said when it defended the shortlist. Null unless it did. */
  negotiationReply: latest<string | null>(() => null),
  negotiationOutcome: latest<NegotiationOutcome | null>(() => null),

  /**
   * Whether a clarifying question has EVER been asked for this application —
   * loaded fresh from the `recommendation_clarify_asked` conversation_action
   * row's existence (lib/ai/recommendation-session.ts's loadRecommendationInputs),
   * never carried over in graph/checkpointer memory. See
   * lib/ai/graph/nodes/clarify.ts for why this is the single durable gate
   * against ever asking twice.
   */
  clarificationAsked: latest<boolean>(() => false),
  /** The applicant's answer to that question, once given — also loaded fresh from the DB each round. */
  clarification: latest<ClarificationAnswer | null>(() => null),

  /**
   * Whether the ONE trade-off question has ever been asked for this
   * application — loaded fresh from the `recommendation_tradeoff_asked`
   * conversation_action row's existence, never carried in graph or
   * checkpointer memory. Separate from `clarificationAsked` because the two
   * ask about different things: `clarify` asks which criterion to weigh,
   * `tradeOff` asks which side of a hard gate the applicant wants to be on.
   * See lib/ai/graph/nodes/tradeoff.ts.
   */
  tradeOffAsked: latest<boolean>(() => false),
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

/**
 * A closed-vocabulary clarifying question — `target` is a `CriterionId`
 * (lib/recommendation/types.ts), never a free field, so a clarification can
 * only ever point at something the scoring engine already knows how to act
 * on. See lib/ai/graph/nodes/clarify.ts.
 */
export type Clarification = { target: CriterionId; question: string };
/** The durable form, loaded back from `conversation_action` rows — never from graph/checkpointer memory. */
export type ClarificationAnswer = Clarification & { rawAnswer: string };

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
  /** Set when `clarify` interrupted with a validated question instead — nothing is presentable yet. */
  pendingClarification: Clarification | null;
  /** Set when `tradeOff` interrupted — the applicant is being asked which side of a hard gate they want. */
  pendingTradeOff: PendingTradeOff | null;
  /** What THIS round extracted — the rows the session writes to `application_preference_signal`. */
  extractedSignals: PreferenceSignal[];
  /** The derived weight set this shortlist was actually built under, with the audit behind it. Stored on the `ai_decision`, so the weights are reconstructable long after the trace has aged out. */
  weights: {
    base: CriterionWeight[];
    dynamic: CriterionWeight[];
    explanation: WeightExplanation[];
    confidence: number;
  };
  servedBy: string | null;
  latencyMs: number;
};

/**
 * `convince` — the objection is answerable from plan facts the applicant has
 * not weighed, so the shortlist stands and the agent says why. `concede` — the
 * objection is a real preference change, so it becomes signals and a new
 * shortlist gets built. Forced to `concede` once the negotiation budget is
 * spent; see MAX_NEGOTIATION_TURNS in lib/ai/graph/nodes/negotiate.ts.
 */
export type NegotiationOutcome = "convince" | "concede";

export type NegotiationResult = {
  outcome: NegotiationOutcome;
  /** What the applicant reads. Empty on a concede — the new shortlist speaks for itself. */
  reply: string;
  /** Including this one. */
  turnsUsed: number;
  /** Set when the agent wanted to argue again but the budget was spent. */
  forced: boolean;
  /** What the objection itself told us about their preferences — written down whether or not they were convinced, because they still said it. */
  extractedSignals: PreferenceSignal[];
  servedBy: string | null;
  latencyMs: number;
};

/** What the applicant is shown, and the two answers they may give — both composed deterministically (lib/recommendation/tradeoff.ts). */
export type PendingTradeOff = {
  question: string;
  options: Record<TradeOffChoice, string>;
  tradeOff: TradeOff;
};

export type PolicyPipelineOutcome = {
  phase: "gated_for_review" | "clarification_required" | "tradeoff_required" | "recommended" | "negotiated" | "exhausted";
  assessment: AssessmentOutcome;
  recommendation: RecommendationOutcome | null;
  /** Set when the applicant rejected a shortlist and the agent answered instead of rebuilding. */
  negotiation: NegotiationResult | null;
  /** Set when the round stopped to ask which side of a hard gate the applicant wants. Nothing was built. */
  tradeOff: PendingTradeOff | null;
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

// ---------------------------------------------------------------------------
// Servicing — one pass through a claim, a pre-authorization or a reimbursement
// ---------------------------------------------------------------------------

/**
 * Same discipline as intake and assessment: the graph holds ONE turn's thinking, and durable state is the
 * rows the session writes afterwards (lib/ai/servicing-session.ts). Nothing here survives the turn — the
 * conversation's memory is `servicing_state` actions, reloaded and revalidated every time (plan §6).
 */
export const ServicingState = Annotation.Root({
  /** The tool context for this turn: rebuilt from rows by the session, mutated by the tools, read back by the session. */
  ctx: latest<ServicingToolContext | null>(() => null),
  /** What the member just did. */
  input: latest<ServicingInput>(() => ({ kind: "text", text: "" })),
  /** The conversation so far, for the model's prompt. */
  transcript: latest<{ role: "member" | "assistant"; text: string }[]>(() => []),
  /** Per-field problems with a form submission, in words a member can act on. */
  formErrors: latest<Partial<Record<string, string>>>(() => ({})),
  /** Refusals from folding the member's act into the draft — for the trace, never shown. */
  notes: latest<string[]>(() => []),
  /** The member asked to change something and has not been shown a fresh confirmation. Persisted by the session. */
  changing: latest<boolean>(() => false),

  turn: latest<ServicingTurn | null>(() => null),
  /** What the session must write for a finished conversation. */
  plan: latest<CommitPlan | null>(() => null),
});

export type ServicingStateType = typeof ServicingState.State;
