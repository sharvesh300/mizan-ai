// The 8 criteria the agent may weight, and the arithmetic it never touches.
//
// The agent decides WHAT matters and HOW MUCH; direction (is more of this
// number good or bad?) and the scoring math are fixed here, not something a
// weight or a prompt can move. A raw value is min-max normalised across the
// plans actually being compared (0 = worst on the panel, 1 = best), so a
// criterion in AED and one in months can be weighted against each other at
// all — comparing raw units directly would let whichever criterion has the
// biggest numbers dominate regardless of the weight it was given.

import type { AssessmentRecord, Catalogue, PlanTerms } from "@/lib/assessment";
import { admitsKey, readNeeds } from "@/lib/assessment";
import { estimateAnnualCost } from "./cost";
import { buildScenario, CONSTANTS_VERSION, scenarioForRecord } from "./scenarios";
import type { CriterionContribution, CriterionDirection, CriterionId, CriterionWeight, ScoredPlan, ScoreResult } from "./types";

export const MIN_WEIGHT = 0.05;
export const MAX_WEIGHT = 0.6;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Scale a weight set to sum to 1, rounded to 2dp, WITHOUT ever pushing a
 * weight outside `[MIN_WEIGHT, MAX_WEIGHT]`.
 *
 * The two goals genuinely conflict: a set with a single criterion in it
 * cannot both sum to 1 and stay under a 0.6 cap. The cap wins, because
 * `scorePlans` rejects an out-of-range weight outright — a set summing to 0.6
 * is scored (it renormalises internally), a set containing 1.0 is an
 * exception. So the rounding residue is placed only where there is headroom,
 * and when there is none it is simply left: sum < 1 is the honest outcome, a
 * weight the engine will refuse is not.
 */
export function settleWeights(weights: CriterionWeight[]): CriterionWeight[] {
  if (weights.length === 0) return weights;

  const total = weights.reduce((s, w) => s + w.weight, 0);
  const scaled = weights.map((w) => ({
    criterionId: w.criterionId,
    weight: round2(Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, total > 0 ? w.weight / total : 1 / weights.length))),
  }));

  let residue = round2(1 - scaled.reduce((s, w) => s + w.weight, 0));
  if (residue === 0) return scaled;

  // Largest first when adding, smallest first when removing — the weight best
  // able to absorb the change is the one least distorted by it.
  const order = [...scaled].sort((a, b) => (residue > 0 ? b.weight - a.weight : a.weight - b.weight));
  for (const w of order) {
    if (residue === 0) break;
    const headroom = residue > 0 ? round2(MAX_WEIGHT - w.weight) : round2(MIN_WEIGHT - w.weight);
    const applied = residue > 0 ? Math.min(residue, headroom) : Math.max(residue, headroom);
    if (applied === 0) continue;
    w.weight = round2(w.weight + applied);
    residue = round2(residue - applied);
  }
  return scaled;
}
export const MAX_CRITERIA = 5;

type CriterionDef = {
  id: CriterionId;
  direction: CriterionDirection;
  isRelevant: (record: AssessmentRecord) => boolean;
  /** Raw value for one plan, in the criterion's own unit. */
  value: (plan: PlanTerms, record: AssessmentRecord, catalogue: Catalogue) => number;
};

const hasHorizonedNeed = (record: AssessmentRecord) =>
  record.needs.some((n) => n.benefitClass != null && n.horizonMonths != null);

/** A priority is free text; the dental/optical tag does not exist in the enum, so this reads the words. */
const declaredDentalOpticalPriority = (record: AssessmentRecord) =>
  record.priorities.some((p) => /dental|optical/i.test(p.rawText));

export const CRITERIA: CriterionDef[] = [
  {
    id: "premium_cost",
    direction: "lower_is_better",
    isRelevant: () => true,
    value: (plan) => plan.annualPremium,
  },
  {
    id: "out_of_pocket_exposure",
    direction: "lower_is_better",
    isRelevant: () => true,
    // Deliberately EXCLUDES the premium — `premium_cost` already weighs that.
    // This is what a plan costs ABOVE the premium: the deductible actually
    // spent plus the co-pay on what's left, under the same stable basket the
    // deterministic fallback uses. Including premium here too (the original
    // "total_annual_outlay" shape) meant weighting this criterion and
    // premium_cost together mostly weighted premium twice — on the seeded
    // catalogue the two came out correlated at r≈0.98 under MEDIUM_OUTPATIENT,
    // because premium dominates the total and the deductible/co-pay term is
    // small next to it. Scoped to the non-premium term, this is an
    // independent signal: two plans with the same premium can still differ
    // here on deductible and co-pay design.
    // The basket is the RECORD's own (`scenarioForRecord`), not a fixed
    // middle: an applicant with a declared maternity need and an expected
    // admission, or a declared chronic condition, does not have a
    // medium-outpatient year, and scoring their exposure as though they did
    // measured a plan against a life they did not describe. The scenario
    // chosen travels out on `ScoreResult.exposureScenario`.
    value: (plan, record) => {
      const breakdown = estimateAnnualCost(plan, buildScenario(scenarioForRecord(record), record));
      return breakdown.deductibleApplied + breakdown.memberCopay;
    },
  },
  {
    id: "need_coverage",
    direction: "higher_is_better",
    isRelevant: (record) => record.needs.length > 0,
    value: (plan, record, catalogue) => {
      const verdicts = readNeeds(record, catalogue);
      if (verdicts.length === 0) return 0;
      return verdicts.filter((v) => v.coveringAnywhere.some((p) => p.id === plan.id)).length;
    },
  },
  {
    id: "waiting_period_fit",
    direction: "higher_is_better",
    isRelevant: hasHorizonedNeed,
    value: (plan, record, catalogue) => {
      const verdicts = readNeeds(record, catalogue);
      if (verdicts.length === 0) return 0;
      return verdicts.filter(
        (v) => v.usableInBudget.some((p) => p.id === plan.id) || v.usableAboveBudget.some((p) => p.id === plan.id),
      ).length;
    },
  },
  {
    id: "network_access",
    direction: "higher_is_better",
    isRelevant: (record) => record.providers.length > 0,
    value: (plan, record, catalogue) =>
      record.providers.filter((p) => p.tier != null && catalogue.admits.has(admitsKey(plan.network, p.tier))).length,
  },
  {
    id: "chronic_depth",
    direction: "higher_is_better",
    isRelevant: (record) => record.conditions.length > 0,
    // Deeper cover reads as "covered, and the wait is short" — not covered at
    // all scores 0, covered-with-no-wait scores highest.
    value: (plan) => (plan.chronicCovered ? 100 / (1 + (plan.chronicWaitingPeriodMonths ?? 0)) : 0),
  },
  {
    id: "annual_limit",
    direction: "higher_is_better",
    isRelevant: () => true,
    // Named for exactly what this is: the plan's stated annual limit. It was
    // previously called "annual_limit_headroom", which promised something
    // this never computed — headroom is limit MINUS expected utilisation,
    // and nothing here subtracts utilisation. Renamed rather than "fixed" to
    // compute real headroom: that would need a utilisation estimate this
    // criterion has no basis for (it runs across the whole panel, not one
    // scenario), so the raw limit is what it honestly is — a ceiling, not a
    // remaining balance.
    value: (plan) => plan.annualLimit,
  },
  {
    id: "dental_optical",
    direction: "higher_is_better",
    isRelevant: declaredDentalOpticalPriority,
    value: (plan) => (plan.dentalOptical === "full" ? 2 : plan.dentalOptical === "basic" ? 1 : 0),
  },
];

const CRITERIA_BY_ID = new Map(CRITERIA.map((c) => [c.id, c]));

export function isCriterionRelevant(id: CriterionId, record: AssessmentRecord): boolean {
  return CRITERIA_BY_ID.get(id)?.isRelevant(record) ?? false;
}

export function scorePlans(
  plans: PlanTerms[],
  record: AssessmentRecord,
  catalogue: Catalogue,
  weights: CriterionWeight[],
): ScoreResult {
  if (weights.length === 0) throw new Error("at least one criterion is required");
  if (weights.length > MAX_CRITERIA) throw new Error(`at most ${MAX_CRITERIA} criteria — an agent that weights everything has prioritised nothing`);

  const seen = new Set<CriterionId>();
  for (const w of weights) {
    if (seen.has(w.criterionId)) throw new Error(`criterion "${w.criterionId}" was weighted twice`);
    seen.add(w.criterionId);

    const def = CRITERIA_BY_ID.get(w.criterionId);
    if (!def) throw new Error(`unknown criterion "${w.criterionId}" — valid set: ${CRITERIA.map((c) => c.id).join(", ")}`);
    if (!def.isRelevant(record)) throw new Error(`criterion "${w.criterionId}" is not relevant to this record`);
    if (w.weight < MIN_WEIGHT || w.weight > MAX_WEIGHT) {
      throw new Error(`weight for "${w.criterionId}" must be between ${MIN_WEIGHT} and ${MAX_WEIGHT}`);
    }
  }

  const sum = weights.reduce((s, w) => s + w.weight, 0);
  const normalisedWeights = weights.map((w) => ({ criterionId: w.criterionId, weight: w.weight / sum }));

  const rawByCriterion = new Map(
    weights.map((w) => {
      const def = CRITERIA_BY_ID.get(w.criterionId)!;
      return [w.criterionId, plans.map((p) => ({ planId: p.id, raw: def.value(p, record, catalogue) }))] as const;
    }),
  );

  const perPlan: ScoredPlan[] = plans.map((plan) => {
    let weightedScore = 0;
    const contributions: CriterionContribution[] = normalisedWeights.map((nw) => {
      const def = CRITERIA_BY_ID.get(nw.criterionId)!;
      const values = rawByCriterion.get(nw.criterionId)!;
      const min = Math.min(...values.map((v) => v.raw));
      const max = Math.max(...values.map((v) => v.raw));
      const raw = values.find((v) => v.planId === plan.id)!.raw;

      let normalisedValue = max === min ? 1 : (raw - min) / (max - min);
      if (def.direction === "lower_is_better") normalisedValue = 1 - normalisedValue;

      const contribution = normalisedValue * nw.weight;
      weightedScore += contribution;
      return { criterionId: nw.criterionId, rawValue: raw, normalisedValue, contribution };
    });

    return { planId: plan.id, weightedScore, rank: 0, contributions };
  });

  perPlan.sort((a, b) => b.weightedScore - a.weightedScore);
  perPlan.forEach((row, i) => {
    row.rank = i + 1;
  });

  // Only when the criterion that depends on it was actually weighted —
  // otherwise no basket was assumed and claiming one would be noise.
  const exposureScenario = weights.some((w) => w.criterionId === "out_of_pocket_exposure")
    ? { id: scenarioForRecord(record), constantsVersion: CONSTANTS_VERSION }
    : null;

  return { rawWeights: weights, normalisedWeights, perPlan, exposureScenario };
}
