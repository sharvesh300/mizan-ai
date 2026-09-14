// `price` — one quote row per plan, before the agent sees anything.
//
// Deterministic, no model. The agent's tools (get_plan_terms,
// estimate_annual_cost) read the catalogue directly rather than these quote
// rows, but pricing happens first because the applicant-facing "all three
// plans, priced" comparison and the recommendation both need the same frozen
// premiums — quoted once, not re-read live from `plan` on every view.

import "server-only";
import { priceAllPlans } from "@/lib/recommendation";
import type { RecommendationStateType } from "@/lib/ai/graph/state";

export function price(state: RecommendationStateType): Partial<RecommendationStateType> {
  return { quotes: priceAllPlans(state.catalogue, state.record) };
}
