// Default policy + stated preference + confidence -> the weights `score_plans`
// actually uses.
//
// Pure arithmetic, no model and no I/O, for the same reason `score.ts` is:
// the agent may decide what matters, it may never decide what the arithmetic
// does with that. `suggestDefaultWeights` (./default-weights.ts) says where
// this applicant's cohort starts; `PreferenceSignal`s (./preference.ts) say
// what they told us; this file is the one place the two are combined, and it
// returns the audit alongside the numbers because a weight nobody can trace
// back to a sentence the applicant said is indistinguishable from a guess.
//
// The engine cannot invent a criterion the record does not support, cannot
// push any weight outside `[MIN_WEIGHT, MAX_WEIGHT]`, and cannot weight more
// than `MAX_CRITERIA` things at once — the same three invariants `scorePlans`
// enforces at the other end, applied here so a violation is impossible to
// construct rather than merely rejected later.

import { isCriterionRelevant, MAX_CRITERIA, MAX_WEIGHT, MIN_WEIGHT, settleWeights } from "./score";
import type { PreferenceSignal } from "./preference";
import type { CriterionId, CriterionWeight } from "./types";
import type { AssessmentRecord } from "@/lib/assessment";

/**
 * The most a criterion's weight can move, in either direction, no matter how
 * many times or how forcefully the applicant said it. A declared tolerance,
 * the same kind `WEIGHT_DELTA` already is: wide enough that a strong, confident
 * preference visibly reorders the panel, narrow enough that stated preference
 * cannot erase the cohort's own read of the record — which is underwriting
 * judgement about risk, not a matter of taste.
 */
export const MAX_SIGNAL_SHIFT = 0.25;

/** Where a criterion the baseline never named enters, when a signal asks for it. Below `NEW_CRITERION_SEED + MAX_SIGNAL_SHIFT` it can still be outranked by a baseline priority, which is the intent: an applicant can raise something new, not displace the cohort. */
export const NEW_CRITERION_SEED = 0.15;

export type WeightExplanation = {
  criterionId: CriterionId;
  baseWeight: number;
  shift: number;
  finalWeight: number;
  /** Every signal that touched this criterion — the audit trail, not a summary of it. */
  drivenBy: PreferenceSignal[];
};

export type DynamicWeightResult = {
  weights: CriterionWeight[];
  /**
   * 0..1 — how much of the final weight set rests on signals we are sure of.
   * The mean signal confidence WEIGHTED BY |shift|, so an uncertain signal that
   * barely moved anything does not drag this down, and an uncertain signal that
   * reordered the panel does. 1 when nothing moved: the cohort baseline alone
   * is not uncertain, it is just the default.
   */
  confidence: number;
  explanation: WeightExplanation[];
};

const clampWeight = (n: number) => Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Signed, saturating aggregate of everything said about one criterion: `+strength x confidence` for increase, `-` for decrease. Summed BEFORE saturating, so five weak repetitions cannot out-push one strong, confident statement. */
function effectFor(signals: PreferenceSignal[]): number {
  const raw = signals.reduce((sum, s) => sum + (s.direction === "increase" ? 1 : -1) * s.strength * s.confidence, 0);
  return Math.min(1, Math.max(-1, raw));
}

export function calculateDynamicWeights(
  baseWeights: CriterionWeight[],
  signals: PreferenceSignal[],
  record: AssessmentRecord,
): DynamicWeightResult {
  // Only signals pointing at something this record can actually be scored on.
  // `validateSignals` already applies this; applying it again here means the
  // engine is safe to call with signals loaded straight from the database,
  // where the record may have changed since they were written.
  const usable = signals.filter((s) => isCriterionRelevant(s.dimension, record));

  const byDimension = new Map<CriterionId, PreferenceSignal[]>();
  for (const signal of usable) {
    byDimension.set(signal.dimension, [...(byDimension.get(signal.dimension) ?? []), signal]);
  }

  const base = new Map(baseWeights.map((w) => [w.criterionId, w.weight]));
  const candidates: WeightExplanation[] = [];

  for (const [criterionId, baseWeight] of base) {
    const drivenBy = byDimension.get(criterionId) ?? [];
    const shift = drivenBy.length > 0 ? effectFor(drivenBy) * MAX_SIGNAL_SHIFT : 0;
    candidates.push({ criterionId, baseWeight, shift, finalWeight: clampWeight(baseWeight + shift), drivenBy });
  }

  for (const [criterionId, drivenBy] of byDimension) {
    if (base.has(criterionId)) continue;
    const effect = effectFor(drivenBy);
    // You cannot lower what was never weighted. A `decrease` on a criterion
    // outside the baseline is the applicant agreeing with the cohort, not an
    // instruction — introducing the criterion in order to de-prioritise it
    // would weight it MORE than leaving it out does.
    if (effect <= 0) continue;
    const shift = effect * MAX_SIGNAL_SHIFT;
    candidates.push({ criterionId, baseWeight: 0, shift, finalWeight: clampWeight(NEW_CRITERION_SEED + shift), drivenBy });
  }

  // A baseline criterion pushed all the way to the floor by an explicit
  // `decrease` has been argued out of the weight set; keep it only if nothing
  // else survives. A criterion that was ALREADY at the floor stays — that is
  // the cohort's own weight, not a preference outcome.
  const argued = candidates.filter((c) => !(c.shift < 0 && c.finalWeight <= MIN_WEIGHT && c.baseWeight > MIN_WEIGHT));
  const kept = (argued.length > 0 ? argued : candidates)
    .sort((a, b) => b.finalWeight - a.finalWeight)
    .slice(0, MAX_CRITERIA);

  return { weights: normalise(kept), confidence: confidenceOf(kept), explanation: kept };
}

/**
 * Scale to sum 1 and round, without letting any weight leave
 * `[MIN_WEIGHT, MAX_WEIGHT]` — `scorePlans` renormalises anyway, but these
 * numbers are shown to an advisor and stored on the `ai_decision`, so a set
 * that visibly sums to 0.99 reads as a bug in the engine, and one containing
 * a weight `scorePlans` would refuse IS one. See `settleWeights` (./score.ts)
 * for why the cap wins when the two cannot both hold.
 */
const normalise = (explanations: WeightExplanation[]): CriterionWeight[] =>
  settleWeights(explanations.map((e) => ({ criterionId: e.criterionId, weight: e.finalWeight })));

/** Mean signal confidence weighted by how far that signal actually moved its criterion. */
function confidenceOf(explanations: WeightExplanation[]): number {
  let weightedSum = 0;
  let totalShift = 0;
  for (const e of explanations) {
    const magnitude = Math.abs(e.shift);
    if (magnitude === 0 || e.drivenBy.length === 0) continue;
    const meanConfidence = e.drivenBy.reduce((sum, s) => sum + s.confidence, 0) / e.drivenBy.length;
    weightedSum += meanConfidence * magnitude;
    totalShift += magnitude;
  }
  // Nothing moved: the baseline alone is the default, not an uncertain guess.
  return totalShift === 0 ? 1 : round2(weightedSum / totalShift);
}
