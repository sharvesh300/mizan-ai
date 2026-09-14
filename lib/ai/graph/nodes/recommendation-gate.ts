// `recommendationGate` — flag the shortlist for an INFORMATIONAL advisor
// quality check, running in parallel with the applicant seeing the cards.
//
// Fires when the deterministic fallback ran, `verify` found a problem, or
// confidence landed on `low` — `outcome.routedToReview` becomes `gated` in
// `persistRecommendation` (lib/ai/recommendation-session.ts), which opens the
// review_task. The applicant is never held back for it: withholding a plan
// they might have accepted anyway is worse than a quiet audit trail, and the
// deterministic hard filters (eligibility, the citation check) already ran
// before this point. This is deliberately distinct from Review 2, which
// fires later, after the applicant has actually picked a card (see
// `pickPlan` in app/applications/new/actions.ts) — Review 2 is what gates
// policy issuance, the one irreversible act in this flow.

import "server-only";
import { interrupt } from "@langchain/langgraph";
import type { RecommendationStateType } from "@/lib/ai/graph/state";

export function recommendationGate(state: RecommendationStateType): Partial<RecommendationStateType> {
  interrupt({
    applicationId: state.record.applicationId,
    reason: state.fellBackTo ?? (state.verifyFailed ? "verification failed" : `confidence: ${state.recoConfidence}`),
    confidence: state.recoConfidence,
  });
  return {};
}

/** The conditional edge out of `verify`. */
export function needsGate(state: RecommendationStateType): "gate" | "present" {
  return state.fellBackTo != null || state.verifyFailed || state.recoConfidence === "low" ? "gate" : "present";
}
