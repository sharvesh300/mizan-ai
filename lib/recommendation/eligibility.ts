// Which plans actually serve this record, and which a `block`-severity flag
// (or a plain coverage gap) has ruled out.
//
// "Eligible" here is a coverage test, not a budget one: a plan that does not
// cover a benefit class the applicant explicitly declared a need for cannot
// serve them regardless of price, so it is excluded outright. A plan above the
// stated budget band is still eligible — that is a cost tradeoff for the
// ranking to weigh, not a hard exclusion (the only rule that hard-excludes on
// budget, `budget_below_cheapest_plan` in lib/assessment/constraint-rules.ts,
// fires when NOTHING on the panel is affordable at all, which routes the whole
// application to a human before recommendation ever runs — see the `in_review`
// guard in lib/ai/recommendation-session.ts).

import { covers, type AssessmentRecord, type PlanTerms } from "@/lib/assessment";

export function isEligible(plan: PlanTerms, record: AssessmentRecord): boolean {
  return record.needs.every((need) => need.benefitClass == null || covers(plan, need.benefitClass));
}

export function shortlistablePlans(plans: PlanTerms[], record: AssessmentRecord): PlanTerms[] {
  const eligible = plans.filter((plan) => isEligible(plan, record));
  // A record with no eligible plan at all still needs a shortlist to reason
  // about — the block-severity gate is what should have stopped this case
  // upstream, not an empty pool here.
  return eligible.length > 0 ? eligible : plans;
}
