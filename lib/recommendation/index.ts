// Recommendation, end to end, with nothing in it that touches a database or a
// model. Given a record and the catalogue, `recommend()` prices all three
// plans and returns the deterministic pick — the fallback path every
// applicant gets when no model is available, and the version
// db/seed/check-recommendation.ts and the graph's own fallback both call.
//
// This is where the model is NOT, by the same discipline lib/assessment uses:
// eligibility, pricing and the deterministic ranking are arithmetic over
// declared rules. The agent (lib/ai/graph/nodes/recommend.ts) may spend a tool
// budget building a better-reasoned shortlist on top of this; it may never
// change what a plan actually costs or covers.

export * from "./types";
export { CONSTANTS_VERSION, INPATIENT_ADMISSION_COST, OUTPATIENT_VISIT_COST, buildScenario, isScenarioSelectable } from "./scenarios";
export { estimateAnnualCost } from "./cost";
export { CRITERIA, MAX_CRITERIA, MAX_WEIGHT, MIN_WEIGHT, isCriterionRelevant, scorePlans } from "./score";
export { isEligible, shortlistablePlans } from "./eligibility";
export { priceAllPlans } from "./quote";
export { fallbackRecommend, type FallbackResult } from "./fallback";

import type { AssessmentRecord, Catalogue } from "@/lib/assessment";
import { fallbackRecommend } from "./fallback";
import { priceAllPlans } from "./quote";
import type { QuoteRow } from "./types";

export type RecommendationResult = {
  quotes: QuoteRow[];
  planId: string;
  brokerReasoning: string;
  memberReasoning: string;
  rejections: { planId: string; reason: string }[];
  confidence: "low";
  uncertaintyReason: string;
};

/**
 * The whole of the deterministic path in one call, with no model in it
 * anywhere. The graph (lib/ai/graph.ts) runs pricing as its own node so the
 * agent can attach after it; this is the version the fixture check and any
 * caller that just wants an answer uses.
 */
export function recommend(input: { record: AssessmentRecord; catalogue: Catalogue }): RecommendationResult {
  const quotes = priceAllPlans(input.catalogue, input.record);
  const outcome = fallbackRecommend(input.record, input.catalogue, quotes);
  return { quotes, ...outcome };
}
