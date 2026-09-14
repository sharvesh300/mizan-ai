// Price all three plans. Deterministic, no model — the `price` graph node and
// the deterministic fallback both call this, so "what got quoted" never
// depends on whether a model was available that day.

import type { AssessmentRecord, Catalogue } from "@/lib/assessment";
import { estimateAnnualCost } from "./cost";
import { isEligible } from "./eligibility";
import { buildScenario } from "./scenarios";
import type { QuoteRow } from "./types";

export function priceAllPlans(catalogue: Catalogue, record: AssessmentRecord): QuoteRow[] {
  const scenario = buildScenario("MEDIUM_OUTPATIENT", record);

  const priced = catalogue.plans.map((plan) => ({
    planId: plan.id,
    annualPremium: plan.annualPremium,
    eligible: isEligible(plan, record),
    totalOutlay: estimateAnnualCost(plan, scenario).total,
  }));

  // Eligible plans first, cheapest realistic-year outlay first within each group.
  priced.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return a.totalOutlay - b.totalOutlay;
  });

  return priced.map((row, i) => ({
    planId: row.planId,
    annualPremium: row.annualPremium,
    eligible: row.eligible,
    rank: i + 1,
    // A small monotonic fit score — lower outlay scores higher — kept simple
    // because `score_plans` (lib/recommendation/score.ts) is where the real
    // multi-criteria judgement happens; this is only the quoting pass.
    score: Math.round((1 / (1 + row.totalOutlay)) * 1_000_000) / 1_000_000,
  }));
}
