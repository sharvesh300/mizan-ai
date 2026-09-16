// A deterministic, cohort-based starting weight set for `score_plans` — the
// one place the recommendation agent otherwise exercised free judgement with
// no grounding at all. The agent still decides; it decides FROM somewhere.
//
// `suggest_default_weights` (lib/ai/tools/plans.ts) must be called before
// `score_plans` in the real recommendation loop (recommend.ts sets
// `enforceWeightBaseline: true`); `score_plans` then requires the agent's
// weights to overlap this baseline and stay within `WEIGHT_DELTA` of it for
// any criterion the baseline also named. Read-only plan-chat re-scoring
// (plan-converse.ts) sets `enforceWeightBaseline: false` — an applicant
// asking "what if price mattered a lot more" about an already-recommended
// plan should be answerable without re-deriving a cohort baseline first.
//
// This is not new judgement: it is the same rationale `assignCohort`
// (lib/assessment/cohort.ts) already states in prose, and `pickByCohort`
// (lib/recommendation/fallback.ts) already reads as a tie-break rule, read a
// third time as starting weights instead of a single winner.

import { isCriterionRelevant, MAX_CRITERIA, MAX_WEIGHT, MIN_WEIGHT } from "./score";
import type { AssessmentRecord } from "@/lib/assessment";
import type { CriterionId, CriterionWeight } from "./types";

/** How far score_plans lets the agent move a baseline criterion's weight, in either direction. A declared tolerance, not a derived one — wide enough for a real adjustment, narrow enough that the agent cannot quietly reverse the cohort's own priority. */
export const WEIGHT_DELTA = 0.15;

/** Deliberately smaller than MAX_CRITERIA (5) so the agent always has room to add its own read of the record — a declared need, a named provider — alongside the baseline, not just adjust it. */
export const BASELINE_MAX_CRITERIA = 3;

type Priority = { criterionId: CriterionId; baseWeight: number };

/**
 * Ordered by importance per cohort; filtered down to what's actually
 * relevant to THIS record (same `isCriterionRelevant` gate `score_plans`
 * itself enforces) before the top `BASELINE_MAX_CRITERIA` are kept.
 */
const COHORT_PRIORITY: Record<string, Priority[]> = {
  // "Waiting-period arithmetic decides this record, not premium band." (cohort.ts)
  maternity_planning: [
    { criterionId: "waiting_period_fit", baseWeight: 0.45 },
    { criterionId: "need_coverage", baseWeight: 0.3 },
    { criterionId: "premium_cost", baseWeight: 0.25 },
  ],
  // "Depth of cover and annual limit outrank premium here." (cohort.ts)
  chronic_complex_senior: [
    { criterionId: "chronic_depth", baseWeight: 0.4 },
    { criterionId: "annual_limit", baseWeight: 0.35 },
    { criterionId: "premium_cost", baseWeight: 0.25 },
  ],
  // "Utilisation is unpredictable and the chronic waiting period lands differently." (cohort.ts)
  chronic_unstable: [
    { criterionId: "chronic_depth", baseWeight: 0.4 },
    { criterionId: "annual_limit", baseWeight: 0.35 },
    { criterionId: "premium_cost", baseWeight: 0.25 },
  ],
  // "The chronic waiting period is the axis this record turns on." (cohort.ts)
  chronic_managed_mature: [
    { criterionId: "chronic_depth", baseWeight: 0.45 },
    { criterionId: "need_coverage", baseWeight: 0.3 },
    { criterionId: "premium_cost", baseWeight: 0.25 },
  ],
  // "Chronic cover matters; expected utilisation is still low." (cohort.ts)
  chronic_managed_adult: [
    { criterionId: "chronic_depth", baseWeight: 0.35 },
    { criterionId: "premium_cost", baseWeight: 0.35 },
    { criterionId: "need_coverage", baseWeight: 0.3 },
  ],
  // "Price-led placement." (cohort.ts)
  standard_young_healthy: [
    { criterionId: "premium_cost", baseWeight: 0.6 },
    { criterionId: "out_of_pocket_exposure", baseWeight: 0.25 },
    { criterionId: "annual_limit", baseWeight: 0.15 },
  ],
  // "Network access and outpatient terms decide this rather than premium band." (cohort.ts)
  standard_mid_career: [
    { criterionId: "network_access", baseWeight: 0.4 },
    { criterionId: "premium_cost", baseWeight: 0.3 },
    { criterionId: "out_of_pocket_exposure", baseWeight: 0.3 },
  ],
  // "Healthy, but the age band carries utilisation risk the record doesn't yet show." (cohort.ts)
  standard_senior_healthy: [
    { criterionId: "network_access", baseWeight: 0.4 },
    { criterionId: "premium_cost", baseWeight: 0.3 },
    { criterionId: "annual_limit", baseWeight: 0.3 },
  ],
};

/** Used when the cohort is unrecognised, or every one of its prioritised criteria turns out irrelevant to this record. */
const DEFAULT_PRIORITY: Priority[] = [
  { criterionId: "premium_cost", baseWeight: 0.5 },
  { criterionId: "out_of_pocket_exposure", baseWeight: 0.3 },
  { criterionId: "annual_limit", baseWeight: 0.2 },
];

const clamp = (n: number) => Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The deterministic baseline `suggest_default_weights` hands the agent.
 * Always at least 1 criterion (falls through cohort → generic default →
 * `premium_cost` alone, which is relevant to every record), never more than
 * `min(BASELINE_MAX_CRITERIA, MAX_CRITERIA)`, every weight inside
 * `[MIN_WEIGHT, MAX_WEIGHT]`, summing to 1 before rounding.
 */
export function suggestDefaultWeights(record: AssessmentRecord, cohort: string): CriterionWeight[] {
  let relevant = (COHORT_PRIORITY[cohort] ?? DEFAULT_PRIORITY).filter((p) => isCriterionRelevant(p.criterionId, record));
  if (relevant.length === 0) relevant = DEFAULT_PRIORITY.filter((p) => isCriterionRelevant(p.criterionId, record));
  if (relevant.length === 0) relevant = [{ criterionId: "premium_cost", baseWeight: 1 }];

  const chosen = relevant.slice(0, Math.min(BASELINE_MAX_CRITERIA, MAX_CRITERIA));
  const sum = chosen.reduce((s, c) => s + c.baseWeight, 0);
  return chosen.map((c) => ({ criterionId: c.criterionId, weight: round2(clamp(c.baseWeight / sum)) }));
}
