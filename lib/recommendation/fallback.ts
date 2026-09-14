// The deterministic recommender. No key, unparseable model output, repeated
// validation failure, or a budget-exhausted agent all land here — same
// principle lib/intake.ts holds for the scripted chat: the app runs end to end
// with no model configured, and a confident wrong guess is worse than none.
//
// Two passes, mirroring the two things the constraint rules already separate:
//
//   1. COVERAGE — is this plan usable at all. A dated (EVENT) need whose wait
//      does not clear in time is not served by that plan in any way that
//      helps, so it drops out of contention for that need exactly as
//      lib/assessment/constraint-rules.ts's EVENT/CONTINUOUS split already
//      argues. A continuous need (chronic management) behind a wait is still
//      real cover, just delayed — it stays in contention.
//
//   2. WHAT THE COHORT SAYS MATTERS — assignCohort() (lib/assessment/cohort.ts)
//      already states, per cohort, which axis decides a placement for that
//      kind of record ("price-led", "network access and outpatient terms",
//      "depth of cover and annual limit outrank premium"). That is not new
//      judgement invented here — it is the same rationale the cohort already
//      carries, read as a tie-break rule instead of prose.
//
// Prose is templated from the numbers this arithmetic actually produced — not
// run through a model at all, so there is nothing for a model failure to break
// here.

import { assignCohort, readNeeds, type AssessmentRecord, type Catalogue, type PlanTerms } from "@/lib/assessment";
import { estimateAnnualCost } from "./cost";
import { shortlistablePlans } from "./eligibility";
import { buildScenario } from "./scenarios";
import type { QuoteRow } from "./types";

export type FallbackResult = {
  planId: string;
  brokerReasoning: string;
  memberReasoning: string;
  rejections: { planId: string; reason: string }[];
  confidence: "low";
  uncertaintyReason: string;
};

const cheapest = (plans: PlanTerms[]): PlanTerms => plans.reduce((best, p) => (p.annualPremium < best.annualPremium ? p : best));

/** Plans that actually clear every declared EVENT need in time — dropped when that would empty the pool. */
function eventFiltered(plans: PlanTerms[], record: AssessmentRecord, catalogue: Catalogue): PlanTerms[] {
  const eventNeeds = readNeeds(record, catalogue).filter((v) => v.isEvent);
  if (eventNeeds.length === 0) return plans;
  const clearing = plans.filter((plan) => eventNeeds.every((v) => v.usableInBudget.some((p) => p.id === plan.id) || v.usableAboveBudget.some((p) => p.id === plan.id)));
  return clearing.length > 0 ? clearing : plans;
}

/** The cohort's own stated axis, read as arithmetic instead of prose. */
function pickByCohort(candidates: PlanTerms[], cohort: string): PlanTerms {
  switch (cohort) {
    case "chronic_complex_senior":
    case "chronic_unstable":
      // "Depth of cover and annual limit outrank premium here."
      return candidates.reduce((best, p) => (p.annualLimit > best.annualLimit ? p : best));
    case "standard_mid_career":
    case "standard_senior_healthy": {
      // "Network access and outpatient terms decide this rather than premium."
      const standard = candidates.find((p) => p.network === "standard");
      return standard ?? cheapest(candidates);
    }
    default:
      // standard_young_healthy ("price-led"), maternity_planning (already
      // event-filtered to what actually clears), chronic_managed_adult/mature
      // ("chronic cover matters; utilisation is still low" / "the waiting
      // period is the axis" — cover being real is enough, price decides the rest).
      return cheapest(candidates);
  }
}

export function fallbackRecommend(record: AssessmentRecord, catalogue: Catalogue, quotes: QuoteRow[]): FallbackResult {
  const eligibleIds = new Set(quotes.filter((q) => q.eligible).map((q) => q.planId));
  const eligible = catalogue.plans.filter((p) => eligibleIds.has(p.id));
  const pool = eligible.length > 0 ? eligible : shortlistablePlans(catalogue.plans, record);
  const candidates = eventFiltered(pool, record, catalogue);

  const cohort = assignCohort(record).cohort;
  const winner = pickByCohort(candidates, cohort);

  const scenario = buildScenario("MEDIUM_OUTPATIENT", record);
  const winnerCost = estimateAnnualCost(winner, scenario);
  const needs = readNeeds(record, catalogue);
  const coveredCount = needs.filter((v) => v.coveringAnywhere.some((p) => p.id === winner.id)).length;

  const rejections = catalogue.plans
    .filter((plan) => plan.id !== winner.id)
    .map((plan) => {
      const wasEligible = eligibleIds.has(plan.id);
      const cost = estimateAnnualCost(plan, scenario);
      const reason = !wasEligible
        ? `Does not cover a benefit class this record declared a need for.`
        : `Estimated ${cost.total} AED/year under a typical-use (MEDIUM_OUTPATIENT) scenario, against ${winner.name}'s ${winnerCost.total} — ${winner.name} rates better for this cohort (${cohort.replace(/_/g, " ")}).`;
      return { planId: plan.id, reason };
    });

  const brokerReasoning = `Deterministic placement — no model judgement applied. Cohort ${cohort.replace(/_/g, " ")}. ${winner.name} covers ${coveredCount} of ${
    needs.length
  } declared need(s), estimated ${winnerCost.total} AED/year under a typical-use (MEDIUM_OUTPATIENT) scenario: ${
    scenario.basket.outpatientVisits
  } outpatient visits, ${scenario.basket.inpatientAdmissions} inpatient admission(s) (constants ${scenario.constantsVersion}).`;

  const memberReasoning = `${winner.name} is the plan that best matches what you told us, at an estimated ${winnerCost.total} AED a year in a typical year (around ${scenario.basket.outpatientVisits} GP visits${
    scenario.basket.inpatientAdmissions > 0 ? ", one hospital stay" : ", no hospital stay"
  }).`;

  return {
    planId: winner.id,
    brokerReasoning,
    memberReasoning,
    rejections,
    confidence: "low",
    uncertaintyReason: "No model judgement was applied — this is a rule-based placement.",
  };
}
