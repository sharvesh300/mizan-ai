// A deterministic, cohort-based starting weight set for `score_plans` — the
// one place the recommendation agent otherwise exercised free judgement with
// no grounding at all. The agent still decides; it decides FROM somewhere.
//
// It is no longer what the agent is handed directly: `calculateDynamicWeights`
// (./dynamic-weights.ts) takes this as its BASE and shifts it by the
// applicant's own stated preferences, and that result is what
// `get_dynamic_weights` (lib/ai/tools/plans.ts) returns and `score_plans`
// holds the agent to, within `WEIGHT_DELTA`. This file answers "where does
// this cohort start"; the engine answers "where does this person end up".
//
// This is not new judgement: it is the same rationale `assignCohort`
// (lib/assessment/cohort.ts) already states in prose, and `pickByCohort`
// (lib/recommendation/fallback.ts) already reads as a tie-break rule, read a
// third time as starting weights instead of a single winner.

import { isCriterionRelevant, MAX_CRITERIA, MAX_WEIGHT, MIN_WEIGHT, settleWeights } from "./score";
import type { AssessmentRecord } from "@/lib/assessment";
import type { CriterionId, CriterionWeight } from "./types";

/**
 * How far `score_plans` lets the agent move a weight from the set it was
 * handed, in either direction.
 *
 * Tightened from 0.15 to 0.10 when the handed set stopped being the bare
 * cohort baseline and became `calculateDynamicWeights`'s output — a set that
 * already carries this applicant's stated preferences. The wider tolerance
 * existed because the baseline was cohort-generic and the agent's read of the
 * individual record was the only thing that could narrow it; that read now
 * arrives as signals, through the engine, with provenance. What is left for
 * the agent is fine-tuning, not re-litigating.
 */
export const WEIGHT_DELTA = 0.1;

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

/**
 * The deterministic cohort baseline `calculateDynamicWeights` starts from.
 * Always at least 1 criterion (falls through cohort → generic default →
 * `premium_cost` alone, which is relevant to every record), never more than
 * `min(BASELINE_MAX_CRITERIA, MAX_CRITERIA)`, every weight inside
 * `[MIN_WEIGHT, MAX_WEIGHT]`, and summing to 1 whenever the clamp leaves room
 * for it — a lone surviving criterion caps at `MAX_WEIGHT` rather than
 * returning 1.0, because `scorePlans` refuses an out-of-range weight outright
 * and renormalises a short one without complaint. See `settleWeights`.
 */
export function suggestDefaultWeights(record: AssessmentRecord, cohort: string): CriterionWeight[] {
  let relevant = (COHORT_PRIORITY[cohort] ?? DEFAULT_PRIORITY).filter((p) => isCriterionRelevant(p.criterionId, record));
  if (relevant.length === 0) relevant = DEFAULT_PRIORITY.filter((p) => isCriterionRelevant(p.criterionId, record));
  if (relevant.length === 0) relevant = [{ criterionId: "premium_cost", baseWeight: 1 }];

  const chosen = relevant.slice(0, Math.min(BASELINE_MAX_CRITERIA, MAX_CRITERIA));

  // Clamp FIRST, then settle the clamped set — not scale-then-clamp, which
  // silently broke the sum-to-1 claim this docblock makes: two surviving
  // priorities of 0.6 and 0.25 scale to 0.71 and 0.29, and the 0.71 clamps
  // back to 0.6, leaving a set summing to 0.89. `scorePlans` renormalises
  // again and hid it, but these weights are now the base
  // `calculateDynamicWeights` shifts from, and they are shown to an advisor.
  return settleWeights(chosen.map((c) => ({ criterionId: c.criterionId, weight: clamp(c.baseWeight) })));
}
