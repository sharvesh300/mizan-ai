// `weights` — default policy + preference signals -> the weights `score_plans`
// is actually held to this round.
//
// No model, no I/O: this node is a thin adapter over
// `calculateDynamicWeights` (lib/recommendation/dynamic-weights.ts), which is
// where the arithmetic and every invariant live. It exists as a node, rather
// than as a line inside `recommend`, for two reasons — it can run in PARALLEL
// with `price` (nothing it reads is anything `price` writes, and vice versa),
// and the weight set plus its explanation land in graph state where `clarify`,
// the session layer and the advisor view can all read them without re-deriving
// anything.

import "server-only";
import { calculateDynamicWeights, suggestDefaultWeights } from "@/lib/recommendation";
import type { RecommendationStateType } from "@/lib/ai/graph/state";

export function weights(state: RecommendationStateType): Partial<RecommendationStateType> {
  const baseWeights = suggestDefaultWeights(state.record, state.cohort?.cohort ?? "unassigned");
  const result = calculateDynamicWeights(baseWeights, state.preferenceSignals, state.record);

  return {
    baseWeights,
    dynamicWeights: result.weights,
    weightExplanation: result.explanation,
    weightConfidence: result.confidence,
  };
}
