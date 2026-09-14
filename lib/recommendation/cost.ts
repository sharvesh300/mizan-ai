// What a plan actually costs under a named basket. Pure arithmetic, no model,
// no I/O — the same discipline lib/assessment's rules hold.
//
// The deductible is spent first, then the co-pay applies to what is left. This
// is a simplification of real claims adjudication (lib/assessment handles the
// coverage/waiting-period question; this file only answers "roughly what would
// a year like this cost"), which is why every figure it produces is labelled
// with the scenario and constants version that made it, never presented bare.

import type { PlanTerms } from "@/lib/assessment";
import { INPATIENT_ADMISSION_COST, OUTPATIENT_VISIT_COST } from "./scenarios";
import type { CostBreakdown, CostScenario } from "./types";

export function estimateAnnualCost(plan: PlanTerms, scenario: CostScenario): CostBreakdown {
  const outpatientCost = scenario.basket.outpatientVisits * OUTPATIENT_VISIT_COST;
  const inpatientCost = scenario.basket.inpatientAdmissions * INPATIENT_ADMISSION_COST;
  const gross = outpatientCost + inpatientCost;

  const deductibleApplied = Math.min(plan.deductible, gross);
  const afterDeductible = gross - deductibleApplied;
  const memberCopay = Math.round(afterDeductible * (plan.outpatientCopayPct / 100));

  return {
    outpatientCost,
    inpatientCost,
    deductibleApplied,
    memberCopay,
    total: Math.round(plan.annualPremium + deductibleApplied + memberCopay),
  };
}
