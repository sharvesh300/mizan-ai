// Why a case leaves the agent — a closed set (plan §7).
//
// The cause is a BROKER's fact: it decides the queue group and the "why this needs
// you" line. It is deliberately not part of any card payload (a member sees a
// reference and two buttons, never the reason the system routed them), and
// `escalate` refuses a cause the state does not justify, so a cause is always true.

export const ESCALATION_CAUSES = [
  "insufficient_data",
  "unresolved_conflict",
  "clarification_limit",
  "evidence_limit",
  "appeal_overturn",
  "correction_needs_review",
  "reassessment_change",
  "model_failure",
  "member_requested",
] as const;
export type EscalationCause = (typeof ESCALATION_CAUSES)[number];

export const ESCALATION_MEANING: Record<EscalationCause, string> = {
  insufficient_data: "the plan terms do not decide this",
  unresolved_conflict: "two sources disagree and no answer settled it",
  clarification_limit: "asked the allowed number of questions and still short a required fact",
  evidence_limit: "asked for what was needed and it did not arrive",
  appeal_overturn: "computed, and needs one signature",
  correction_needs_review: "the evidence bears on the finding, but correcting it needs a person — no input this engine holds can apply it",
  reassessment_change: "a plan change recommendation needs a human",
  model_failure: "the loop did not complete; fall back, do not guess",
  member_requested: "the member asked for a person",
};

/** A cause as a badge — the broker's shorthand. Never shown to a member: the cause is the queue's fact, not theirs. */
export const ESCALATION_LABEL: Record<EscalationCause, string> = {
  insufficient_data: "Undecidable",
  unresolved_conflict: "Conflict unresolved",
  clarification_limit: "Question limit reached",
  evidence_limit: "Evidence limit reached",
  appeal_overturn: "Reversal to sign",
  correction_needs_review: "Evidence needs reading",
  reassessment_change: "Plan change",
  model_failure: "Agent stopped",
  member_requested: "Member asked for a person",
};
