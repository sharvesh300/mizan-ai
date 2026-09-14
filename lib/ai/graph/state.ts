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
 * durable record is the `assessment` / `assessment_flag` / `review_task` rows
 * the caller writes afterwards.
 *
 * `fired` is carried as rule+flag pairs rather than flags alone, because
 * `narrate` rewrites wording and `route` reads severity and confidence floors.
 * One of those is allowed to change what the broker reads; the other decides
 * where the application goes, and they must not be able to touch each other.
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
});

export type AssessmentStateType = typeof AssessmentState.State;

export type AssessmentOutcome = Assessment & {
  /** True when `gate` stopped the graph and a human now owns this. */
  routedToReview: boolean;
  narrated: string[];
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
